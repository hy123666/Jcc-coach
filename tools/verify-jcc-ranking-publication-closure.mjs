import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ACTIVE_RANKING_CLOSURE_FILE,
  ACTIVE_RANKING_CLOSURE_MIGRATION_FILE,
  CORE_RANKING_PUBLICATION_INTENT_FILE,
  activateRankingClosure,
  assertRankingSemanticMaintenanceReady,
  completeCoreRankingPublicationTransaction,
  readCoreRankingPublicationIntentSync,
  resolveActiveRankingClosureSync,
  restoreActiveRankingClosure,
  synchronizeRankingClosureCompatibilityMirrors,
} from "./jcc_live_rankings_active_closure.mjs";
import { acquireLiveRankingRefreshLease } from "./jcc_live_rankings_generation_store.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const sourceRoot = path.join(repoRoot, "data", "live-rankings", "jcc");
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-ranking-publication-closure-"));
const storeRoot = path.join(tempRoot, "store");

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

try {
  const rankingPointer = await readJson(path.join(sourceRoot, "active-generation.json"));
  const recipePointer = await readJson(path.join(sourceRoot, "active-recipe-generation.json"));
  await cp(
    path.join(sourceRoot, "generations", rankingPointer.generation_id),
    path.join(storeRoot, "generations", rankingPointer.generation_id),
    { recursive: true },
  );
  await cp(
    path.join(sourceRoot, "recipe-generations", recipePointer.generation_id),
    path.join(storeRoot, "recipe-generations", recipePointer.generation_id),
    { recursive: true },
  );
  await writeFile(path.join(storeRoot, "active-generation.json"), `${JSON.stringify(rankingPointer)}\n`);
  await writeFile(path.join(storeRoot, "active-recipe-generation.json"), `${JSON.stringify(recipePointer)}\n`);

  const rankingDir = path.join(storeRoot, "generations", rankingPointer.generation_id);
  const strategyIndex = await readJson(path.join(rankingDir, "lineup-strategy-index.json"));
  const manifest = await readJson(path.join(rankingDir, "manifest.json"));
  const audit = await readJson(path.join(rankingDir, "audit.json"));
  const receipt = assertRankingSemanticMaintenanceReady({ strategyIndex, manifest, audit });
  assert(new Set(["ready", "degraded", "not_required"]).has(receipt.status),
    "publication accepts ready, explicitly degraded, or not-required semantic maintenance");
  assert.equal(receipt.annotation_count, strategyIndex.tiers["0"].lineup_candidates.length);

  assert.throws(
    () => assertRankingSemanticMaintenanceReady({
      strategyIndex: { ...strategyIndex, semantic_maintenance: undefined },
      manifest,
      audit,
    }),
    /receipt is missing/,
    "a generation without semantic maintenance must not be publishable",
  );
  const degradedReceipt = {
    ...receipt,
    status: "degraded",
    failure_code: "host_request_timeout",
    failure_reason: "optional semantic annotation Host timed out",
  };
  assert.doesNotThrow(
    () => assertRankingSemanticMaintenanceReady({
      strategyIndex: { ...strategyIndex, semantic_maintenance: degradedReceipt },
      manifest: { ...manifest, semantic_maintenance: degradedReceipt },
      audit: { ...audit, semantic_maintenance: degradedReceipt },
    }),
    "degraded semantic maintenance may publish complete deterministic Ranking facts with explicit diagnostics",
  );
  assert.throws(
    () => assertRankingSemanticMaintenanceReady({
      strategyIndex,
      manifest: { ...manifest, semantic_maintenance: { ...receipt, annotation_count: 0 } },
      audit,
    }),
    /inconsistent across artifacts/,
    "semantic maintenance receipt copies must agree before publication",
  );

  const identity = {
    core_profile_id: rankingPointer.core_profile_id,
    season_id: rankingPointer.season_id,
    patch_id: rankingPointer.patch_id,
    catalog_fingerprint: rankingPointer.catalog_fingerprint,
    hard_data_manifest_fingerprint: rankingPointer.hard_data_manifest_fingerprint,
  };
  const lease = await acquireLiveRankingRefreshLease({ rootDir: storeRoot });
  try {
    const activated = await activateRankingClosure({
      rootDir: storeRoot,
      rankingGenerationId: rankingPointer.generation_id,
      recipeGenerationId: recipePointer.generation_id,
      statDate: rankingPointer.stat_date,
      identity,
      lease,
    });
    assert.equal(activated.pointer.ranking_generation_id, rankingPointer.generation_id);

    const resolved = resolveActiveRankingClosureSync({ rootDir: storeRoot, expectedIdentity: identity });
    assert.equal(resolved.availability, "available");
    assert.equal(resolved.closure_status, "available");
    assert(new Set(["ready", "degraded", "not_required"]).has(resolved.ranking.semantic_maintenance.status),
      "resolved active closure must retain a publishable semantic maintenance receipt");

    const mirrorFailure = await synchronizeRankingClosureCompatibilityMirrors({
      rootDir: storeRoot,
      identity,
      lease,
      activators: {
        activateRanking: async () => { throw new Error("injected ranking mirror failure"); },
        activateRecipe: async () => { throw new Error("injected recipe mirror failure"); },
      },
    });
    assert.equal(mirrorFailure.status, "degraded");
    assert.equal(mirrorFailure.errors.length, 2);
    const afterMirrorFailure = resolveActiveRankingClosureSync({ rootDir: storeRoot, expectedIdentity: identity });
    assert.equal(afterMirrorFailure.availability, "available");
    assert.equal(afterMirrorFailure.ranking_generation_id, rankingPointer.generation_id);
    assert.equal(afterMirrorFailure.recipe_generation_id, recipePointer.generation_id);

    const singleMirrorFailure = await synchronizeRankingClosureCompatibilityMirrors({
      rootDir: storeRoot,
      identity,
      lease,
      activators: {
        activateRanking: async () => ({ pointer: { generation_id: rankingPointer.generation_id } }),
        activateRecipe: async () => { throw new Error("injected recipe-only mirror failure"); },
      },
    });
    assert.equal(singleMirrorFailure.status, "degraded");
    assert.deepEqual(singleMirrorFailure.errors.map((entry) => entry.mirror), ["active-recipe-generation"]);

    const mismatchedMirror = await synchronizeRankingClosureCompatibilityMirrors({
      rootDir: storeRoot,
      identity,
      lease,
      activators: {
        activateRanking: async () => ({ pointer: { generation_id: "20991231-aaaaaaaaaaaaaaaaaaaaaaaa" } }),
        activateRecipe: async () => ({ pointer: { generation_id: recipePointer.generation_id } }),
      },
    });
    assert.equal(mismatchedMirror.status, "degraded");
    assert.equal(mismatchedMirror.ranking, null);
    assert.match(mismatchedMirror.errors[0].error, /expected/);

    const closureBytes = await readFile(path.join(storeRoot, ACTIVE_RANKING_CLOSURE_FILE));
    const renewed = await activateRankingClosure({
      rootDir: storeRoot,
      rankingGenerationId: rankingPointer.generation_id,
      recipeGenerationId: recipePointer.generation_id,
      statDate: rankingPointer.stat_date,
      identity,
      lease,
    });
    await restoreActiveRankingClosure({
      rootDir: storeRoot,
      previousPointerBytes: closureBytes,
      expectedCurrentRankingGenerationId: renewed.pointer.ranking_generation_id,
      expectedCurrentRecipeGenerationId: renewed.pointer.recipe_generation_id,
      lease,
    });
    assert.deepEqual(await readFile(path.join(storeRoot, ACTIVE_RANKING_CLOSURE_FILE)), closureBytes);

    await restoreActiveRankingClosure({
      rootDir: storeRoot,
      previousPointerBytes: null,
      expectedCurrentRankingGenerationId: rankingPointer.generation_id,
      expectedCurrentRecipeGenerationId: recipePointer.generation_id,
      lease,
    });
    const fallback = resolveActiveRankingClosureSync({ rootDir: storeRoot, expectedIdentity: identity });
    assert.equal(fallback.availability, "unavailable");
    assert.equal(fallback.legacy_fallback, false);
    assert.match(fallback.reason, /active(?: Ranking)? closure/i);

    let activeCore = { core_profile_id: "f".repeat(64) };
    let promoteCalls = 0;
    await assert.rejects(
      completeCoreRankingPublicationTransaction({
        rootDir: storeRoot,
        identity,
        rankingGenerationId: rankingPointer.generation_id,
        recipeGenerationId: recipePointer.generation_id,
        statDate: rankingPointer.stat_date,
        lease,
        readActiveCoreProfile: async () => activeCore,
        promoteCoreProfile: async () => {
          promoteCalls += 1;
          activeCore = { core_profile_id: identity.core_profile_id };
        },
        crashHook: async (boundary) => {
          if (boundary === "core_committed") throw new Error("injected process crash after Core commit");
        },
      }),
      /injected process crash after Core commit/,
    );
    assert.equal(promoteCalls, 1);
    assert.equal(activeCore.core_profile_id, identity.core_profile_id);
    assert.equal(readCoreRankingPublicationIntentSync({ rootDir: storeRoot }).intent.status, "core_committed");

    const pending = readCoreRankingPublicationIntentSync({ rootDir: storeRoot }).intent;
    const competing = {
      ...pending,
      stat_date: pending.stat_date === "20991231" ? "20991230" : "20991231",
    };
    competing.transaction_id = createHash("sha256").update(JSON.stringify({
      core_profile_id: competing.core_profile_id,
      season_id: competing.season_id,
      patch_id: competing.patch_id,
      catalog_fingerprint: competing.catalog_fingerprint,
      hard_data_manifest_fingerprint: competing.hard_data_manifest_fingerprint,
      stat_date: competing.stat_date,
      ranking_generation_id: competing.ranking_generation_id,
      recipe_generation_id: competing.recipe_generation_id,
    })).digest("hex");
    await writeFile(
      path.join(storeRoot, CORE_RANKING_PUBLICATION_INTENT_FILE),
      `${JSON.stringify(competing, null, 2)}\n`,
    );
    await assert.rejects(
      completeCoreRankingPublicationTransaction({
        rootDir: storeRoot,
        identity,
        rankingGenerationId: rankingPointer.generation_id,
        recipeGenerationId: recipePointer.generation_id,
        statDate: rankingPointer.stat_date,
        lease,
        readActiveCoreProfile: async () => activeCore,
        promoteCoreProfile: async () => { throw new Error("must not promote competing identity"); },
      }),
      /another Core\+Ranking publication identity is pending/,
    );
    await writeFile(
      path.join(storeRoot, CORE_RANKING_PUBLICATION_INTENT_FILE),
      `${JSON.stringify(pending, null, 2)}\n`,
    );

    const closureMigrationPath = path.join(storeRoot, ACTIVE_RANKING_CLOSURE_MIGRATION_FILE);
    await rm(closureMigrationPath, { force: true });
    await mkdir(closureMigrationPath);
    const markerFailure = await completeCoreRankingPublicationTransaction({
      rootDir: storeRoot,
      identity,
      rankingGenerationId: rankingPointer.generation_id,
      recipeGenerationId: recipePointer.generation_id,
      statDate: rankingPointer.stat_date,
      lease,
      readActiveCoreProfile: async () => activeCore,
      promoteCoreProfile: async () => { throw new Error("marker repair must not promote Core twice"); },
    });
    assert.equal(markerFailure.status, "committed_needs_repair");
    assert.equal(markerFailure.active_closure.ranking_generation_id, rankingPointer.generation_id);
    assert.equal(markerFailure.active_closure.recipe_generation_id, recipePointer.generation_id);
    assert.deepEqual(markerFailure.mirrors.errors.map((entry) => entry.mirror), ["closure_post_commit_metadata"]);
    const markerFailureIntent = readCoreRankingPublicationIntentSync({ rootDir: storeRoot }).intent;
    assert.equal(markerFailureIntent.status, "committed_needs_repair");
    assert.equal(markerFailureIntent.ranking_generation_id, rankingPointer.generation_id);
    assert.equal(markerFailureIntent.recipe_generation_id, recipePointer.generation_id);
    await rm(closureMigrationPath, { recursive: true, force: true });

    const committedNeedsRepair = await completeCoreRankingPublicationTransaction({
      rootDir: storeRoot,
      identity,
      rankingGenerationId: rankingPointer.generation_id,
      recipeGenerationId: recipePointer.generation_id,
      statDate: rankingPointer.stat_date,
      lease,
      readActiveCoreProfile: async () => activeCore,
      promoteCoreProfile: async () => { throw new Error("recovery must not promote Core twice"); },
      activators: {
        activateRanking: async () => { throw new Error("injected post-closure mirror failure"); },
      },
    });
    assert.equal(committedNeedsRepair.status, "committed_needs_repair");
    assert.equal(committedNeedsRepair.active_closure.ranking_generation_id, rankingPointer.generation_id);
    assert.equal(readCoreRankingPublicationIntentSync({ rootDir: storeRoot }).intent.status, "committed_needs_repair");

    const cleanupFailure = await completeCoreRankingPublicationTransaction({
      rootDir: storeRoot,
      identity,
      rankingGenerationId: rankingPointer.generation_id,
      recipeGenerationId: recipePointer.generation_id,
      statDate: rankingPointer.stat_date,
      lease,
      readActiveCoreProfile: async () => activeCore,
      promoteCoreProfile: async () => { throw new Error("cleanup recovery must not promote Core twice"); },
      publicationOperations: {
        removeIntent: async ({ intentFile }) => {
          assert.equal((await readJson(intentFile)).status, "committed_needs_repair");
          throw new Error("injected publication intent cleanup failure");
        },
      },
    });
    assert.equal(cleanupFailure.status, "committed_needs_repair");
    assert.equal(cleanupFailure.active_closure.ranking_generation_id, rankingPointer.generation_id);
    assert.equal(cleanupFailure.active_closure.recipe_generation_id, recipePointer.generation_id);
    assert.deepEqual(cleanupFailure.cleanup.errors, [{
      operation: "publication_intent_cleanup",
      error: "injected publication intent cleanup failure",
    }]);
    const cleanupFailureIntent = readCoreRankingPublicationIntentSync({ rootDir: storeRoot }).intent;
    assert.equal(cleanupFailureIntent.status, "committed_needs_repair");
    assert.deepEqual(cleanupFailureIntent.cleanup_errors, cleanupFailure.cleanup.errors);

    const repaired = await completeCoreRankingPublicationTransaction({
      rootDir: storeRoot,
      identity,
      rankingGenerationId: rankingPointer.generation_id,
      recipeGenerationId: recipePointer.generation_id,
      statDate: rankingPointer.stat_date,
      lease,
      readActiveCoreProfile: async () => activeCore,
      promoteCoreProfile: async () => { throw new Error("repair must not promote Core twice"); },
    });
    assert.equal(repaired.status, "committed");
    assert.equal(repaired.resumed, true);
    assert.equal(readCoreRankingPublicationIntentSync({ rootDir: storeRoot }), null);
  } finally {
    await lease.release();
  }

  console.log(JSON.stringify({
    ok: true,
    schema: "jcc-ranking-publication-closure-verification-v1",
    checked: [
      "ready_semantic_maintenance_is_complete_and_consistent",
      "missing_semantic_maintenance_is_rejected_and_degraded_is_explicitly_allowed",
      "paired_ranking_and_recipe_closure_activates_atomically",
      "compatibility_mirror_failure_does_not_change_authoritative_closure",
      "single_compatibility_mirror_failure_requires_repair",
      "compatibility_mirror_id_mismatch_requires_repair",
      "closure_rollback_restores_previous_pointer_or_legacy_fallback",
      "durable_intent_recovers_after_process_crash_at_core_commit",
      "competing_publication_identity_is_rejected_while_intent_is_pending",
      "post_commit_marker_failure_preserves_committed_pair_as_needing_repair",
      "post_commit_mirror_failure_is_committed_needs_repair_and_resumable",
      "post_commit_intent_cleanup_failure_preserves_recoverable_intent_and_diagnostics",
    ],
  }, null, 2));
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
