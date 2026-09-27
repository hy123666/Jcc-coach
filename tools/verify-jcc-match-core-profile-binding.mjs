import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createRuntimePaths } from "../ui/electron/runtime-state-store.js";
import { loadActiveRulesBundle } from "./jcc_active_rules_contract.mjs";
import {
  buildPack,
  resolveMatchCoreProfileRuntimePaths,
} from "./build-jcc-host-agent-context-pack.mjs";
import {
  liveRankingBindingFromSourceIdentity,
  publishLiveRankingGeneration,
  sha256File,
} from "./jcc_live_rankings_generation_store.mjs";
import { buildWorkerPlan } from "./build-jcc-runtime-worker-plan.mjs";
import {
  bootstrap,
  configureRuntimeServicePaths,
  getRuntimeServiceState,
  setRuntimeServiceState,
} from "../ui/electron/runtime-service.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const activePaths = createRuntimePaths(repoRoot);
const activeRules = loadActiveRulesBundle({ repoRoot, runtimePaths: activePaths });
const snapshot = {
  schema: "jcc-match-season-version-snapshot-v1",
  captured_at: "2026-08-21T00:00:00.000Z",
  activation_policy: "new_match_only",
  promotion_tuple: structuredClone(activePaths.activePromotionTuple),
  rules_source_fingerprint: activeRules.source_fingerprint,
  core_profile_id: activePaths.activeCoreProfileId,
  core_profile_ref: structuredClone(activePaths.activeCoreProfile),
  core_profile_artifacts: {
    hard_data_manifest: activePaths.activeHardDataManifest,
    decision_input_catalog: activePaths.activeDecisionInputCatalogFile,
    augment_stage_authority: activePaths.activeDecisionInputAugmentStageAuthorityFile,
    runtime_catalog_overlay: activePaths.activeRuntimeCatalogOverlayFile,
    semantic_feature_index: activePaths.activeSemanticFeatureIndexFile,
    bundle: activePaths.activeCoreProfileBundleFile,
  },
  core_source_identity: structuredClone(activePaths.activeDecisionInputCatalogSourceIdentity),
  ranking_overlay_id: null,
  ranking_overlay_identity: {
    schema: "jcc-live-ranking-overlay-identity-v1",
    availability: "unavailable",
    ranking_overlay_id: null,
    core_profile_id: activePaths.activeCoreProfileId,
    season_id: activePaths.activeSeasonId,
    patch_id: activePaths.activePatchId,
  },
  recipe_catalog_generation_id: null,
  recipe_catalog_identity: {
    schema: "jcc-ranking-recipe-catalog-identity-v1",
    availability: "unavailable",
    generation_id: null,
    core_profile_id: activePaths.activeCoreProfileId,
    season_id: activePaths.activeSeasonId,
    patch_id: activePaths.activePatchId,
  },
  knowledge_lifecycle: {
    core_profile: "fixed_for_match",
    ranking_overlay: "fixed_for_match",
    recipe_catalog: "fixed_for_match",
  },
};

const fakePromotedPaths = {
  ...activePaths,
  activeCoreProfileId: "b".repeat(64),
  activeCoreProfile: { ...activePaths.activeCoreProfile, core_profile_id: "b".repeat(64) },
  activeCoreProfileBundleFile: path.join(repoRoot, "data", "game-knowledge", "jcc", "generated", `${"b".repeat(64)}`, "bundle.json"),
  activeDecisionInputCatalogFile: path.join(repoRoot, "data", "game-knowledge", "jcc", "generated", `${"b".repeat(64)}`, "decision-input-catalog.json"),
  activeDecisionInputAugmentStageAuthorityFile: path.join(repoRoot, "data", "game-knowledge", "jcc", "generated", `${"b".repeat(64)}`, "augment-stage-authority.json"),
  activeRuntimeCatalogOverlayFile: path.join(repoRoot, "data", "game-knowledge", "jcc", "generated", `${"b".repeat(64)}`, "runtime-catalog-overlay.json"),
};

const pinned = resolveMatchCoreProfileRuntimePaths({
  repoRoot,
  baseRuntimePaths: fakePromotedPaths,
  seasonVersionSnapshot: snapshot,
  expectedCoreProfileId: snapshot.core_profile_id,
});
assert.equal(pinned.activeCoreProfileId, snapshot.core_profile_id, "pinned binding must win over the current active pointer");
assert.equal(pinned.activeCoreProfileBundleFile, activePaths.activeCoreProfileBundleFile, "pinned bundle must use Match A generation");
assert.equal(pinned.activeDecisionInputCatalogFile, activePaths.activeDecisionInputCatalogFile, "pinned catalog must use Match A generation");

const strippedSemanticPointerSnapshot = structuredClone(snapshot);
delete strippedSemanticPointerSnapshot.core_profile_artifacts.semantic_feature_index;
delete strippedSemanticPointerSnapshot.core_profile_ref.semantic_feature_index_path;
delete strippedSemanticPointerSnapshot.core_profile_ref.semantic_feature_index_sha256;
delete strippedSemanticPointerSnapshot.core_profile_ref.semantic_feature_index_byte_size;
assert.throws(() => resolveMatchCoreProfileRuntimePaths({
  repoRoot,
  baseRuntimePaths: fakePromotedPaths,
  seasonVersionSnapshot: strippedSemanticPointerSnapshot,
  expectedCoreProfileId: strippedSemanticPointerSnapshot.core_profile_id,
}), /semantic feature artifact pointer is missing/);

const rankingStoreRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-match-ranking-binding-"));
try {
  const binding = liveRankingBindingFromSourceIdentity(activePaths.activeDecisionInputCatalogSourceIdentity);
  const publishSyntheticRanking = async (statDate, marker) => {
    const candidateDir = path.join(rankingStoreRoot, `candidate-${marker}`);
    await mkdir(candidateDir, { recursive: true });
    const files = ["snapshot.json", "rank-signal.json", "lineup-strategy-index.json", "latest-diff.json", "audit.json", "manifest.json"];
    for (const file of files) await writeFile(path.join(candidateDir, file), `${JSON.stringify({ marker, file })}\n`, "utf8");
    return publishLiveRankingGeneration({
      rootDir: rankingStoreRoot,
      candidateDir,
      statDate,
      binding,
      artifacts: await Promise.all(files.map(async (file) => ({ path: file, sha256: await sha256File(path.join(candidateDir, file)) }))),
    });
  };
  const publishSyntheticRecipe = async (statDate, marker) => {
    const document = {
      schema: "jcc-live-ranking-recipe-generation-v1",
      identity: {
        core_profile_id: binding.core_profile_id,
        season_id: binding.season_id,
        patch_id: binding.patch_id,
      },
      capability: {
        source_capabilities: {
          winning: { status: "available", source_stat_date: statDate },
          popular: { status: "available", source_stat_date: statDate },
        },
      },
      recipes: [],
      marker,
    };
    const text = `${JSON.stringify(document, null, 2)}\n`;
    const generationId = createHash("sha256").update(text).digest("hex");
    const generationDir = path.join(rankingStoreRoot, "recipe-generations", generationId);
    await mkdir(generationDir, { recursive: true });
    await writeFile(path.join(generationDir, "recipes.json"), text, "utf8");
    return { generation_id: generationId, generation_dir: generationDir };
  };
  const rankingA = await publishSyntheticRanking("20260821", "a");
  const recipeA = await publishSyntheticRecipe("20260821", "a");
  const rankingSnapshot = {
    ...snapshot,
    ranking_overlay_id: rankingA.pointer.generation_id,
    ranking_overlay_identity: {
      schema: "jcc-live-ranking-overlay-identity-v1",
      availability: "available",
      ranking_overlay_id: rankingA.pointer.generation_id,
      core_profile_id: binding.core_profile_id,
      season_id: binding.season_id,
      patch_id: binding.patch_id,
      catalog_fingerprint: binding.catalog_fingerprint,
      ranking_overlay_fingerprint: rankingA.pointer.content_sha256,
      ranking_stat_date: rankingA.pointer.stat_date,
    },
    recipe_catalog_generation_id: recipeA.generation_id,
    recipe_catalog_identity: {
      schema: "jcc-ranking-recipe-catalog-identity-v1",
      availability: "available",
      generation_id: recipeA.generation_id,
      core_profile_id: binding.core_profile_id,
      season_id: binding.season_id,
      patch_id: binding.patch_id,
      stat_date: rankingA.pointer.stat_date,
      closure_ranking_generation_id: rankingA.pointer.generation_id,
      accepted_recipe_count: 0,
    },
  };
  const rankingB = await publishSyntheticRanking("20260822", "b");
  await publishSyntheticRecipe("20260822", "b");
  const rankingPinned = resolveMatchCoreProfileRuntimePaths({
    repoRoot,
    baseRuntimePaths: {
      ...fakePromotedPaths,
      liveRankingsRoot: rankingStoreRoot,
      activeRankingGenerationId: rankingB.pointer.generation_id,
      activeRankingGenerationPointer: rankingB.pointer,
    },
    seasonVersionSnapshot: rankingSnapshot,
    expectedCoreProfileId: rankingSnapshot.core_profile_id,
  });
  assert.equal(rankingPinned.activeRankingGenerationId, rankingA.pointer.generation_id, "Match rebuild must retain captured Ranking Overlay A after active advances to B");
  assert.equal(rankingPinned.liveRankingsCurrentDir, rankingA.generation_dir, "Match rebuild must read the immutable captured ranking generation");
  assert.equal(rankingPinned.activeRankingClosure.recipe_generation_id, recipeA.generation_id, "Match rebuild must retain the recipe generation paired with Ranking A");
  const mismatchedRecipeSnapshot = structuredClone(rankingSnapshot);
  mismatchedRecipeSnapshot.recipe_catalog_identity.closure_ranking_generation_id = rankingB.pointer.generation_id;
  assert.throws(() => resolveMatchCoreProfileRuntimePaths({
    repoRoot,
    baseRuntimePaths: {
      ...fakePromotedPaths,
      liveRankingsRoot: rankingStoreRoot,
      activeRankingGenerationId: rankingB.pointer.generation_id,
      activeRankingGenerationPointer: rankingB.pointer,
    },
    seasonVersionSnapshot: mismatchedRecipeSnapshot,
    expectedCoreProfileId: mismatchedRecipeSnapshot.core_profile_id,
  }), /does not belong to the pinned Ranking publication closure/);
} finally {
  await rm(rankingStoreRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

const pack = await buildPack({
  scope: "match",
  matchSessionId: "profile-binding-match-a",
  outDir: "unused",
  runtimePaths: fakePromotedPaths,
  seasonVersionSnapshot: snapshot,
  expectedCoreProfileId: snapshot.core_profile_id,
});
assert.equal(pack.core_profile_id, snapshot.core_profile_id, "context rebuild must stay on Match A");
assert.equal(pack.active_season_module.core_profile_id, snapshot.core_profile_id, "context pack must expose the pinned Profile");

const plan = await buildWorkerPlan({
  mode: "cruise",
  event: "profile_binding_regression",
  matchSessionId: "profile-binding-match-a",
  runtimePaths: fakePromotedPaths,
  seasonVersionSnapshot: snapshot,
  expectedCoreProfileId: snapshot.core_profile_id,
});
assert.equal(plan.core_profile_id, snapshot.core_profile_id, "worker plan must stay on Match A");
assert(plan.core_profile_artifacts.bundle.endsWith(`${snapshot.core_profile_id}${path.sep}bundle.json`), "worker plan must carry pinned artifact path");

await assert.rejects(
  () => buildPack({ scope: "match", matchSessionId: "missing-snapshot", outDir: "unused" }),
  /requires --season-snapshot-base64url and --expected-core-profile-id/,
);
await assert.rejects(
  () => buildWorkerPlan({ mode: "cruise", matchSessionId: "missing-snapshot" }),
  /requires --season-snapshot-base64url and --expected-core-profile-id/,
);

const bootstrapSource = await readFile(path.join(repoRoot, "ui", "electron", "runtime-service.js"), "utf8");
const bootstrapBody = bootstrapSource.slice(
  bootstrapSource.indexOf("async function bootstrap(options = {})"),
  bootstrapSource.indexOf("async function detectHostCli"),
);
assert(
  !bootstrapBody.includes("restorePersistedMatchCoreProfileBinding()")
    && bootstrapBody.indexOf("shutdownRuntime(") < bootstrapBody.indexOf("reconcileHostAgentSessionHomes"),
  "new app bootstrap must retire the old Match before Host route reconciliation",
);

const tempDataRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-match-profile-binding-"));
try {
  configureRuntimeServicePaths({ dataRoot: tempDataRoot });
  setRuntimeServiceState({
    match_session: {
      status: "active",
      match_session_id: "restart-match-a",
      season_version_snapshot: snapshot,
    },
    host_sessions: {
      match: { route_key: "match:restart-match-a", provider_session_id: "provider-a" },
    },
  });
  const bootstrapResult = await bootstrap({ testMode: true });
  assert.equal(bootstrapResult.ok, true, "new app bootstrap must complete");
  const recoveredState = getRuntimeServiceState();
  assert.equal(
    recoveredState.match_session.status,
    "idle",
    "new app must not restore the previous Match Profile",
  );
  const leaseFile = path.join(tempDataRoot, "state", "jcc-game-knowledge-generation-leases.json");
  const leases = JSON.parse(await readFile(leaseFile, "utf8"));
  assert(!leases.leases.some((lease) => lease.match_session_id === "restart-match-a"), "new app must release the retired Match generation lease");
  assert.equal(recoveredState.match_session.match_session_id, null, "new app must require a new Start Match");
} finally {
  await rm(tempDataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

console.log(JSON.stringify({
  ok: true,
  schema: "jcc-match-core-profile-binding-verifier-v1",
  checked: [
    "promotion race keeps context pack on persisted Match A Profile",
    "promotion race keeps worker plan on persisted Match A artifacts",
    "new semantic-feature Core Profiles reject stripped Match artifact pointers",
    "ranking promotion race keeps the Match on captured immutable Ranking Overlay A",
    "ranking promotion race keeps the Match on the recipe generation paired with Ranking A",
    "mismatched Ranking and recipe closure identities fail closed",
    "production match builders reject implicit active-pointer resolution",
    "bootstrap restart retires the previous Match and releases its generation leases",
  ],
}, null, 2));
