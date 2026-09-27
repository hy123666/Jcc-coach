import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ACTIVE_GENERATION_POINTER,
  GENERATIONS_DIRECTORY,
  REFRESH_LEASE_DIRECTORY,
  acquireLiveRankingRefreshLease,
  activateLiveRankingGeneration,
  pruneLiveRankingGenerations,
  publishLiveRankingGeneration,
  resolveActiveLiveRankingGeneration,
  resolveActiveLiveRankingGenerationPathSync,
  resolveLiveRankingGenerationPathSync,
  sha256File,
} from "./jcc_live_rankings_generation_store.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "jcc-ranking-generation-store-"));
const storeRoot = path.join(root, "store");
const bindingA = {
  core_profile_id: "1".repeat(64),
  season_id: "s17",
  patch_id: "s17_8",
  catalog_fingerprint: "2".repeat(64),
  hard_data_manifest_fingerprint: "3".repeat(64),
};
const bindingB = { ...bindingA, core_profile_id: "4".repeat(64) };
const recipeGenerationA = "5".repeat(64);
const recipeGenerationB = "6".repeat(64);

async function makeCandidate(name, files) {
  const directory = path.join(root, name);
  await mkdir(directory, { recursive: true });
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(directory, ...relativePath.split("/"));
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, contents, "utf8");
  }
  const artifacts = [];
  for (const relativePath of Object.keys(files).sort()) {
    artifacts.push({ path: relativePath, sha256: await sha256File(path.join(directory, ...relativePath.split("/"))) });
  }
  return { directory, artifacts };
}

async function pointerBytes() {
  return readFile(path.join(storeRoot, ACTIVE_GENERATION_POINTER));
}

try {
  const candidateA = await makeCandidate("candidate-a", {
    "audit.json": "{\"status\":\"pass\"}\n",
    "indexes/lineups.json": "{\"marker\":\"A\"}\n",
    "snapshot.json": "{\"stat_date\":\"20260818\",\"marker\":\"A\"}\n",
  });
  await assert.rejects(() => publishLiveRankingGeneration({
    rootDir: storeRoot,
    candidateDir: candidateA.directory,
    artifacts: candidateA.artifacts,
    statDate: "20260818",
  }), /exact Core identity/);
  const publishedA = await publishLiveRankingGeneration({
    rootDir: storeRoot,
    candidateDir: candidateA.directory,
    artifacts: candidateA.artifacts,
    statDate: "20260818",
    binding: bindingA,
  });
  const pointerAfterA = await pointerBytes();
  const resolvedA = await resolveActiveLiveRankingGeneration({ rootDir: storeRoot });
  assert.equal(resolvedA.generation_id, publishedA.pointer.generation_id);
  assert.deepEqual(Object.fromEntries(Object.keys(bindingA).map((key) => [key, resolvedA.metadata[key]])), bindingA);
  assert.deepEqual(Object.fromEntries(Object.keys(bindingA).map((key) => [key, resolvedA.pointer[key]])), bindingA);
  assert.equal(resolveLiveRankingGenerationPathSync({
    rootDir: storeRoot,
    generationId: publishedA.pointer.generation_id,
  })?.generation_dir, publishedA.generation_dir);
  assert.equal(resolveActiveLiveRankingGenerationPathSync({
    rootDir: storeRoot,
    generationId: publishedA.pointer.generation_id,
  })?.generation_dir, publishedA.generation_dir);
  assert.equal(await readFile(path.join(resolvedA.generation_dir, "indexes", "lineups.json"), "utf8"), "{\"marker\":\"A\"}\n");

  const badHash = candidateA.artifacts.map((artifact) => artifact.path === "audit.json"
    ? { ...artifact, sha256: "0".repeat(64) }
    : artifact);
  await assert.rejects(() => publishLiveRankingGeneration({
    rootDir: storeRoot,
    candidateDir: candidateA.directory,
    artifacts: badHash,
    statDate: "20260819",
    binding: bindingA,
  }), /hash mismatch/);
  assert.deepEqual(await pointerBytes(), pointerAfterA, "invalid candidate must leave the active pointer byte-for-byte unchanged");

  const missingSet = candidateA.artifacts.filter((artifact) => artifact.path !== "snapshot.json");
  await assert.rejects(() => publishLiveRankingGeneration({
    rootDir: storeRoot,
    candidateDir: candidateA.directory,
    artifacts: missingSet,
    statDate: "20260819",
    binding: bindingA,
  }), /complete artifact set/);
  assert.deepEqual(await pointerBytes(), pointerAfterA, "incomplete candidate set must leave the pointer unchanged");

  const candidateB = await makeCandidate("candidate-b", {
    "audit.json": "{\"status\":\"pass\"}\n",
    "indexes/lineups.json": "{\"marker\":\"B\"}\n",
    "snapshot.json": "{\"stat_date\":\"20260819\",\"marker\":\"B\"}\n",
  });
  const publishedB = await publishLiveRankingGeneration({
    rootDir: storeRoot,
    candidateDir: candidateB.directory,
    artifacts: candidateB.artifacts,
    statDate: "20260819",
    binding: bindingA,
  });
  assert.notEqual(publishedB.pointer.generation_id, publishedA.pointer.generation_id);
  const resolvedB = await resolveActiveLiveRankingGeneration({ rootDir: storeRoot });
  assert.equal(resolvedB.generation_id, publishedB.pointer.generation_id);
  assert.equal(await readFile(path.join(resolvedB.generation_dir, "indexes", "lineups.json"), "utf8"), "{\"marker\":\"B\"}\n");
  assert.equal(await readFile(path.join(publishedA.generation_dir, "indexes", "lineups.json"), "utf8"), "{\"marker\":\"A\"}\n", "A must remain immutable after publishing B");

  const pointerBeforeCandidate = await pointerBytes();
  const candidateOnly = await makeCandidate("candidate-only", {
    "audit.json": "{\"status\":\"pass\"}\n",
    "indexes/lineups.json": "{\"marker\":\"candidate-only\"}\n",
    "snapshot.json": "{\"stat_date\":\"20260820\",\"marker\":\"candidate-only\"}\n",
  });
  const candidatePublication = await publishLiveRankingGeneration({
    rootDir: storeRoot,
    candidateDir: candidateOnly.directory,
    artifacts: candidateOnly.artifacts,
    statDate: "20260820",
    binding: bindingA,
    activatePointer: false,
  });
  assert.equal(candidatePublication.activated, false);
  assert.deepEqual(await pointerBytes(), pointerBeforeCandidate, "candidate publication must not replace the active pointer");
  assert.equal((await resolveActiveLiveRankingGeneration({ rootDir: storeRoot })).generation_id, publishedB.pointer.generation_id);
  await activateLiveRankingGeneration({ rootDir: storeRoot, generationId: candidatePublication.pointer.generation_id });
  assert.equal((await resolveActiveLiveRankingGeneration({ rootDir: storeRoot })).generation_id, candidatePublication.pointer.generation_id);
  await activateLiveRankingGeneration({ rootDir: storeRoot, generationId: publishedB.pointer.generation_id });
  const activeLineups = path.join(resolvedB.generation_dir, "indexes", "lineups.json");
  await writeFile(activeLineups, "{\"marker\":\"tampered\"}\n", "utf8");
  await assert.rejects(
    () => resolveActiveLiveRankingGeneration({ rootDir: storeRoot }),
    /hash mismatch/,
    "reader must reject an active generation whose immutable contents were changed",
  );
  assert.throws(
    () => resolveLiveRankingGenerationPathSync({
      rootDir: storeRoot,
      generationId: publishedB.pointer.generation_id,
    }),
    /hash mismatch/,
    "Runtime sync resolver must reject an immutable generation whose artifact bytes were changed",
  );
  assert.throws(
    () => resolveActiveLiveRankingGenerationPathSync({ rootDir: storeRoot }),
    /hash mismatch/,
    "active Runtime sync resolver must reject an immutable generation whose artifact bytes were changed",
  );
  await writeFile(activeLineups, "{\"marker\":\"B\"}\n", "utf8");
  assert.equal((await resolveActiveLiveRankingGeneration({ rootDir: storeRoot })).generation_id, publishedB.pointer.generation_id);

  const heldLease = await acquireLiveRankingRefreshLease({ rootDir: storeRoot, leaseMs: 30_000 });
  try {
    await assert.rejects(() => publishLiveRankingGeneration({
      rootDir: storeRoot,
      candidateDir: candidateA.directory,
      artifacts: candidateA.artifacts,
      statDate: "20260820",
      binding: bindingA,
    }), /already held/);
    const leaseDir = path.join(storeRoot, REFRESH_LEASE_DIRECTORY);
    await writeFile(path.join(leaseDir, "owner.json"), `${JSON.stringify({
      ...heldLease.owner,
      expires_at: "2020-01-01T00:00:01.000Z",
    })}\n`, "utf8");
    await assert.rejects(
      () => acquireLiveRankingRefreshLease({ rootDir: storeRoot, leaseMs: 30_000 }),
      /already held/,
      "an expired timestamp must not preempt a still-live local owner",
    );
    await heldLease.renew();
    await heldLease.assertOwnership();
  } finally {
    await heldLease.release();
  }

  const leaseDir = path.join(storeRoot, REFRESH_LEASE_DIRECTORY);
  await mkdir(leaseDir);
  await writeFile(path.join(leaseDir, "owner.json"), `${JSON.stringify({
    schema: "jcc-live-ranking-refresh-lease-v1",
    lease_id: "stale-owner",
    pid: 2147483647,
    hostname: os.hostname(),
    acquired_at: "2020-01-01T00:00:00.000Z",
    expires_at: "2020-01-01T00:00:01.000Z",
  })}\n`, "utf8");
  const recoveredLease = await acquireLiveRankingRefreshLease({ rootDir: storeRoot, leaseMs: 30_000 });
  await recoveredLease.assertOwnership();
  await recoveredLease.release();

  const sameDateDrift = await makeCandidate("candidate-same-date-drift", {
    "audit.json": "{\"status\":\"pass\"}\n",
    "indexes/lineups.json": "{\"marker\":\"B2\"}\n",
    "snapshot.json": "{\"stat_date\":\"20260819\",\"marker\":\"B2\"}\n",
  });
  const publishedB2 = await publishLiveRankingGeneration({
    rootDir: storeRoot,
    candidateDir: sameDateDrift.directory,
    artifacts: sameDateDrift.artifacts,
    statDate: "20260819",
    binding: bindingA,
  });
  assert.notEqual(publishedB2.pointer.generation_id, publishedB.pointer.generation_id, "same-date content drift must create a new immutable generation");
  assert.equal(await readFile(path.join(publishedB.generation_dir, "indexes", "lineups.json"), "utf8"), "{\"marker\":\"B\"}\n");

  await assert.rejects(() => publishLiveRankingGeneration({
    rootDir: storeRoot,
    candidateDir: candidateA.directory,
    artifacts: [{ path: "../escape.json", sha256: "0".repeat(64) }],
    statDate: "20260820",
    binding: bindingA,
  }), /normalized relative path/);

  const symlinkCandidate = await makeCandidate("candidate-symlink", { "audit.json": "{}\n" });
  const outside = path.join(root, "outside.json");
  await writeFile(outside, "outside\n", "utf8");
  await symlink(outside, path.join(symlinkCandidate.directory, "escape.json"), "file");
  await assert.rejects(() => publishLiveRankingGeneration({
    rootDir: storeRoot,
    candidateDir: symlinkCandidate.directory,
    artifacts: symlinkCandidate.artifacts,
    statDate: "20260820",
    binding: bindingA,
  }), /symlink/);

  const identityDrift = await publishLiveRankingGeneration({
    rootDir: storeRoot,
    candidateDir: candidateA.directory,
    artifacts: candidateA.artifacts,
    statDate: "20260821",
    binding: bindingB,
    activatePointer: false,
  });
  assert.notEqual(identityDrift.pointer.generation_id, publishedA.pointer.generation_id);
  assert.deepEqual(Object.fromEntries(Object.keys(bindingB).map((key) => [key, identityDrift.pointer[key]])), bindingB);

  const candidatesDir = path.join(storeRoot, "candidates");
  await mkdir(candidatesDir, { recursive: true });
  await writeFile(path.join(candidatesDir, `${bindingA.core_profile_id}.json`), `${JSON.stringify({
    schema: "jcc-live-ranking-candidate-pointer-v1",
    ...bindingA,
    generation_id: candidatePublication.pointer.generation_id,
    recipe_generation_id: recipeGenerationA,
    stat_date: candidatePublication.pointer.stat_date,
    content_sha256: candidatePublication.pointer.content_sha256,
    status: "ready",
  }, null, 2)}\n`, "utf8");
  await writeFile(path.join(candidatesDir, `${bindingB.core_profile_id}.json`), `${JSON.stringify({
    schema: "jcc-live-ranking-candidate-pointer-v1",
    ...bindingB,
    generation_id: identityDrift.pointer.generation_id,
    recipe_generation_id: recipeGenerationB,
    stat_date: identityDrift.pointer.stat_date,
    content_sha256: identityDrift.pointer.content_sha256,
    status: "ready",
  }, null, 2)}\n`, "utf8");
  const pruned = await pruneLiveRankingGenerations({
    rootDir: storeRoot,
    leasedGenerationIds: [publishedA.pointer.generation_id, identityDrift.pointer.generation_id],
    validCoreProfileIds: [bindingA.core_profile_id],
    validRecipeGenerationIds: [recipeGenerationA],
    keepPrevious: 1,
  });
  assert.equal(pruned.active_generation_id, publishedB2.pointer.generation_id);
  assert.deepEqual(pruned.candidate_generation_ids, [candidatePublication.pointer.generation_id]);
  assert.deepEqual(pruned.candidate_core_profile_ids, [bindingA.core_profile_id]);
  assert.deepEqual(pruned.candidate_recipe_generation_ids, [recipeGenerationA]);
  assert.deepEqual(pruned.removed_candidate_core_profile_ids, [bindingB.core_profile_id]);
  await assert.rejects(readFile(path.join(candidatesDir, `${bindingB.core_profile_id}.json`)), /ENOENT/);
  assert.deepEqual(pruned.leased_generation_ids, [publishedA.pointer.generation_id, identityDrift.pointer.generation_id].sort());
  assert.ok(!pruned.previous_generation_ids.includes(identityDrift.pointer.generation_id));
  for (const retainedId of [
    publishedB2.pointer.generation_id,
    candidatePublication.pointer.generation_id,
    publishedA.pointer.generation_id,
    identityDrift.pointer.generation_id,
  ]) {
    assert.ok(resolveLiveRankingGenerationPathSync({ rootDir: storeRoot, generationId: retainedId }));
  }

  await writeFile(path.join(candidatesDir, `${bindingA.core_profile_id}.json`), `${JSON.stringify({
    schema: "jcc-live-ranking-candidate-pointer-v1",
    ...bindingA,
    generation_id: candidatePublication.pointer.generation_id,
    recipe_generation_id: recipeGenerationB,
    stat_date: candidatePublication.pointer.stat_date,
    content_sha256: candidatePublication.pointer.content_sha256,
    status: "ready",
  }, null, 2)}\n`, "utf8");
  const brokenRecipePrune = await pruneLiveRankingGenerations({
    rootDir: storeRoot,
    validCoreProfileIds: [bindingA.core_profile_id],
    validRecipeGenerationIds: [recipeGenerationA],
    keepPrevious: 10,
  });
  assert.ok(brokenRecipePrune.deleted_generation_ids.includes(identityDrift.pointer.generation_id), "Retired Core Ranking must be removed after lease release even with spare history capacity");
  assert.deepEqual(brokenRecipePrune.removed_broken_candidate_core_profile_ids, [bindingA.core_profile_id]);
  assert.deepEqual(brokenRecipePrune.candidate_generation_ids, []);
  assert.deepEqual(brokenRecipePrune.candidate_recipe_generation_ids, []);
  await assert.rejects(readFile(path.join(candidatesDir, `${bindingA.core_profile_id}.json`)), /ENOENT/);

  const retentionStoreRoot = path.join(root, "retention-store");
  const managedCandidate = async (name, generatedAt, marker, semanticStatus = null) => makeCandidate(name, {
    "audit.json": "{\"status\":\"pass\"}\n",
    "manifest.json": `${JSON.stringify({
      schema_version: 1,
      generated_at: generatedAt,
      source_identity: { core_profile_id: bindingA.core_profile_id },
      current: { stat_date: "20260822" },
      retention_policy: "test",
      ...(semanticStatus ? { semantic_maintenance: { status: semanticStatus } } : {}),
    })}\n`,
    "snapshot.json": `${JSON.stringify({ stat_date: "20260822", marker })}\n`,
  });
  const finalizedOlderCandidate = await managedCandidate("managed-finalized-older", "2026-08-22T01:00:00.000Z", "older", "ready");
  const finalizedNewerCandidate = await managedCandidate("managed-finalized-newer", "2026-08-22T03:00:00.000Z", "newer", "ready");
  const finalizedDegradedCandidate = await managedCandidate("managed-finalized-degraded", "2026-08-22T04:00:00.000Z", "degraded", "degraded");
  const preparedCandidate = await managedCandidate("managed-prepared", "2026-08-22T05:00:00.000Z", "prepared");
  const activeCandidate = await managedCandidate("managed-active", "2026-08-22T06:00:00.000Z", "active", "ready");
  const finalizedOlder = await publishLiveRankingGeneration({ rootDir: retentionStoreRoot, candidateDir: finalizedOlderCandidate.directory, artifacts: finalizedOlderCandidate.artifacts, statDate: "20260822", binding: bindingA, activatePointer: false });
  const finalizedNewer = await publishLiveRankingGeneration({ rootDir: retentionStoreRoot, candidateDir: finalizedNewerCandidate.directory, artifacts: finalizedNewerCandidate.artifacts, statDate: "20260822", binding: bindingA, activatePointer: false });
  const finalizedDegraded = await publishLiveRankingGeneration({ rootDir: retentionStoreRoot, candidateDir: finalizedDegradedCandidate.directory, artifacts: finalizedDegradedCandidate.artifacts, statDate: "20260822", binding: bindingA, activatePointer: false });
  const preparedOnly = await publishLiveRankingGeneration({ rootDir: retentionStoreRoot, candidateDir: preparedCandidate.directory, artifacts: preparedCandidate.artifacts, statDate: "20260822", binding: bindingA, activatePointer: false });
  const activeManaged = await publishLiveRankingGeneration({ rootDir: retentionStoreRoot, candidateDir: activeCandidate.directory, artifacts: activeCandidate.artifacts, statDate: "20260822", binding: bindingA });
  const managedPrune = await pruneLiveRankingGenerations({ rootDir: retentionStoreRoot, keepPrevious: 1 });
  assert.equal(managedPrune.active_generation_id, activeManaged.pointer.generation_id);
  assert.deepEqual(managedPrune.previous_generation_ids, [finalizedDegraded.pointer.generation_id], "Previous retention must include finalized degraded semantic generations");
  assert.ok(managedPrune.deleted_generation_ids.includes(finalizedOlder.pointer.generation_id));
  assert.ok(managedPrune.deleted_generation_ids.includes(finalizedNewer.pointer.generation_id));
  assert.ok(managedPrune.deleted_generation_ids.includes(preparedOnly.pointer.generation_id));
  assert.deepEqual(managedPrune.discarded_unfinalized_generation_ids, [preparedOnly.pointer.generation_id]);

  const generationEntries = await readdir(path.join(storeRoot, GENERATIONS_DIRECTORY));
  assert.equal(generationEntries.some((name) => name.startsWith(".tmp-generation-")), false, "failed publications must clean generation temp directories");
  const rootEntries = await readdir(storeRoot);
  assert.equal(rootEntries.some((name) => name.startsWith(".tmp-active-generation-") || name.startsWith(".stale-refresh-lease-")), false, "pointer and stale-lease temp entries must be cleaned");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    schema: "jcc-live-ranking-generation-store-verifier-v1",
    checked: [
      "invalid_or_missing_candidate_leaves_pointer_unchanged",
      "a_b_publication_resolves_one_whole_generation",
      "candidate_publication_requires_explicit_activation",
      "reader_rejects_generation_content_hash_drift",
      "active_generation_is_never_renamed_or_removed",
      "exclusive_refresh_lease_refuses_concurrent_publisher",
      "expired_timestamp_does_not_preempt_live_owner",
      "expired_or_dead_owner_lease_recovers",
      "same_date_content_drift_creates_new_generation",
      "generation_and_pointer_freeze_core_identity",
      "candidate_pointers_for_pruned_core_profiles_are_removed_before_generation_retention",
      "candidate_pointers_with_missing_recipe_generations_are_removed_before_generation_retention",
      "sync_resolution_supports_explicit_generation_id",
      "prune_protects_active_candidate_leased_and_bounded_previous",
      "prune_counts_only_finalized_semantic_generations_as_previous",
      "prune_orders_same_date_previous_versions_by_generated_time",
      "traversal_and_symlink_escape_are_rejected",
      "failed_publication_cleans_temporary_entries",
    ],
  }, null, 2)}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
