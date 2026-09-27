import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  acquireLiveRankingRefreshLease,
} from "./jcc_live_rankings_generation_store.mjs";
import {
  ACTIVE_RANKING_CLOSURE_FILE,
  ACTIVE_RANKING_CLOSURE_SCHEMA,
  activateRankingClosure,
  resolveActiveRankingClosureSync,
  resolveRankingRefreshBaselineClosureSync,
} from "./jcc_live_rankings_active_closure.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const sourceRoot = path.join(repoRoot, "data", "live-rankings", "jcc");
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-ranking-active-closure-"));
const storeRoot = path.join(tempRoot, "store");

try {
  const activeRankingPointer = JSON.parse(await readFile(path.join(sourceRoot, "active-generation.json"), "utf8"));
  const activeRecipePointer = JSON.parse(await readFile(path.join(sourceRoot, "active-recipe-generation.json"), "utf8"));
  const rankingGenerationDir = path.join(sourceRoot, "generations", activeRankingPointer.generation_id);
  const recipeGenerationDir = path.join(sourceRoot, "recipe-generations", activeRecipePointer.generation_id);
  await cp(rankingGenerationDir, path.join(storeRoot, "generations", activeRankingPointer.generation_id), { recursive: true });
  await cp(recipeGenerationDir, path.join(storeRoot, "recipe-generations", activeRecipePointer.generation_id), { recursive: true });
  await writeFile(path.join(storeRoot, "active-generation.json"), `${JSON.stringify(activeRankingPointer, null, 2)}\n`);
  await writeFile(path.join(storeRoot, "active-recipe-generation.json"), `${JSON.stringify(activeRecipePointer, null, 2)}\n`);

  const expectedIdentity = {
    core_profile_id: activeRankingPointer.core_profile_id,
    season_id: activeRankingPointer.season_id,
    patch_id: activeRankingPointer.patch_id,
    catalog_fingerprint: activeRankingPointer.catalog_fingerprint,
    hard_data_manifest_fingerprint: activeRankingPointer.hard_data_manifest_fingerprint,
  };

  const compatibility = resolveActiveRankingClosureSync({ rootDir: storeRoot, expectedIdentity });
  assert.equal(compatibility.availability, "unavailable");
  assert.equal(compatibility.closure_status, "missing");
  assert.equal(compatibility.legacy_fallback, false);

  const lease = await acquireLiveRankingRefreshLease({ rootDir: storeRoot });
  try {
    const activated = await activateRankingClosure({
      rootDir: storeRoot,
      rankingGenerationId: activeRankingPointer.generation_id,
      recipeGenerationId: activeRecipePointer.generation_id,
      statDate: activeRankingPointer.stat_date,
      identity: expectedIdentity,
      lease,
    });
    assert.equal(activated.pointer.schema, ACTIVE_RANKING_CLOSURE_SCHEMA);
  } finally {
    await lease.release();
  }

  const closed = resolveActiveRankingClosureSync({ rootDir: storeRoot, expectedIdentity });
  assert.equal(closed.availability, "available");
  assert.equal(closed.closure_status, "available");
  assert.equal(closed.legacy_fallback, false);
  assert.equal(closed.ranking_generation_id, activeRankingPointer.generation_id);
  assert.equal(closed.recipe_generation_id, activeRecipePointer.generation_id);

  const cachedClosed = resolveActiveRankingClosureSync({
    rootDir: storeRoot,
    expectedIdentity,
    reuseValidated: true,
  });
  const reusedClosed = resolveActiveRankingClosureSync({
    rootDir: storeRoot,
    expectedIdentity,
    reuseValidated: true,
  });
  assert.equal(reusedClosed, cachedClosed, "unchanged immutable closure dependencies should reuse the validated result");

  const cachedAuditFile = path.join(storeRoot, "generations", activeRankingPointer.generation_id, "audit.json");
  const cachedAuditText = await readFile(cachedAuditFile, "utf8");
  await writeFile(cachedAuditFile, `${cachedAuditText.trimEnd()} \n`, "utf8");
  const invalidatedClosed = resolveActiveRankingClosureSync({
    rootDir: storeRoot,
    expectedIdentity,
    reuseValidated: true,
  });
  assert.notEqual(invalidatedClosed, cachedClosed, "an in-place artifact change must invalidate the validated closure cache");
  assert.equal(invalidatedClosed.availability, "unavailable");
  assert.equal(invalidatedClosed.closure_status, "invalid");
  await writeFile(cachedAuditFile, cachedAuditText, "utf8");
  const restoredClosed = resolveActiveRankingClosureSync({
    rootDir: storeRoot,
    expectedIdentity,
    reuseValidated: true,
  });
  assert.equal(restoredClosed.availability, "available", "restoring the immutable artifact must allow validation again");

  const nextCoreIdentity = {
    ...expectedIdentity,
    core_profile_id: "a".repeat(64),
    catalog_fingerprint: "b".repeat(64),
    hard_data_manifest_fingerprint: "c".repeat(64),
  };
  const staleCoreBaseline = resolveRankingRefreshBaselineClosureSync({
    rootDir: storeRoot,
    expectedIdentity: nextCoreIdentity,
  });
  assert.equal(staleCoreBaseline.availability, "available");
  assert.equal(staleCoreBaseline.closure_status, "stale_core");
  assert.equal(staleCoreBaseline.target_compatible, false);
  assert.equal(staleCoreBaseline.replacement_required, true);
  assert.equal(staleCoreBaseline.ranking_generation_id, activeRankingPointer.generation_id);

  // Once the paired closure exists, a stale or damaged legacy mirror must not
  // change the generation consumed by Runtime.
  await writeFile(path.join(storeRoot, "active-generation.json"), "{\"stale\":true}\n");
  const staleMirror = resolveActiveRankingClosureSync({ rootDir: storeRoot, expectedIdentity });
  assert.equal(staleMirror.availability, "available");
  assert.equal(staleMirror.closure_status, "available");
  assert.equal(staleMirror.ranking_generation_id, activeRankingPointer.generation_id);

  await rm(path.join(storeRoot, ACTIVE_RANKING_CLOSURE_FILE), { force: true });
  const missingAfterMigration = resolveActiveRankingClosureSync({ rootDir: storeRoot, expectedIdentity });
  assert.equal(missingAfterMigration.availability, "unavailable");
  assert.equal(missingAfterMigration.closure_status, "invalid");
  assert.equal(missingAfterMigration.legacy_fallback, false);

  await writeFile(path.join(storeRoot, ACTIVE_RANKING_CLOSURE_FILE), `${JSON.stringify(closed.pointer, null, 2)}\n`);

  await writeFile(path.join(storeRoot, ACTIVE_RANKING_CLOSURE_FILE), `${JSON.stringify({
    ...closed.pointer,
    recipe_generation_id: "0".repeat(64),
  }, null, 2)}\n`);
  const corrupted = resolveActiveRankingClosureSync({ rootDir: storeRoot, expectedIdentity });
  assert.equal(corrupted.availability, "unavailable");
  assert.equal(corrupted.closure_status, "invalid");
  assert.equal(corrupted.legacy_fallback, false);

  console.log(JSON.stringify({
    ok: true,
    schema: "jcc-live-ranking-active-closure-store-verifier-v1",
    checked: [
      "independent_legacy_pointers_cannot_be_recomposed_without_a_paired_closure",
      "ranking_and_recipe_activate_as_one_closure",
      "validated_closure_cache_reuses_unchanged_immutable_dependencies",
      "validated_closure_cache_invalidates_on_artifact_change",
      "active_closure_becomes_authoritative_after_first_activation",
      "stale_legacy_mirror_cannot_override_active_closure",
      "missing_closure_after_migration_fails_closed_without_dual_pointer_recomposition",
      "invalid_closure_fails_closed_without_legacy_fallback",
      "complete_previous_core_closure_is_a_replaceable_refresh_baseline",
    ],
  }, null, 2));
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
