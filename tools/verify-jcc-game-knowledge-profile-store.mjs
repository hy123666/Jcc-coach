import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  loadActiveGameKnowledgeProfileSync,
  pruneGameKnowledgeGenerations,
  promoteGameKnowledgeCandidate,
  readGameKnowledgeGenerationLeases,
  restoreActiveGameKnowledgeProfile,
} from "./jcc_game_knowledge_profile_store.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function writeCandidateGeneration(knowledgeRoot, id, runtimeIdentity, timestamp) {
  const generation = path.join(knowledgeRoot, "generated", id);
  const candidates = path.join(knowledgeRoot, "candidates");
  await mkdir(generation, { recursive: true });
  await mkdir(candidates, { recursive: true });
  const sourceIdentity = {
    season_id: "s18",
    active_patch_id: "s18_1",
    core_profile_id: id,
    hard_data_source_ref: `core_profile_hard_data_manifest:${runtimeIdentity.hard_data_manifest}`,
    hard_data_manifest_fingerprint: "f".repeat(64),
    catalog_source_fingerprint: "e".repeat(64),
  };
  const artifacts = {
    bundle: `${JSON.stringify({
      schema: "jcc-game-knowledge-bundle-v1",
      combined_fingerprint: id,
      profile: { season_id: "s18", patch_id: "s18_1" },
      runtime_identity: runtimeIdentity,
    })}\n`,
    decisionInputCatalog: `${JSON.stringify({
      schema: "jcc-decision-input-catalog-v1",
      source_identity: sourceIdentity,
      entities: [],
      aliases: [],
    })}\n`,
    augmentStageAuthority: `${JSON.stringify({
      schema: "jcc-decision-input-augment-stage-authority-v1",
      source_identity: sourceIdentity,
      augment_stage_bindings: [],
      generated_augments: [],
    })}\n`,
    runtimeCatalogOverlay: `${JSON.stringify({
      schema: "jcc-runtime-catalog-overlay-v1",
      source_identity: sourceIdentity,
      champions_by_id: {},
      items_by_id: {},
    })}\n`,
    semanticFeatureIndex: `${JSON.stringify({
      schema: "jcc-semantic-feature-index-v1",
      identity: { season_id: "s18", patch_id: "s18_1", core_profile_id: id },
      entities: [],
    })}\n`,
  };
  const bundleObject = JSON.parse(artifacts.bundle);
  bundleObject.semantic_feature_index = JSON.parse(artifacts.semanticFeatureIndex);
  artifacts.bundle = `${JSON.stringify(bundleObject)}\n`;
  await Promise.all([
    writeFile(path.join(generation, "bundle.json"), artifacts.bundle, "utf8"),
    writeFile(path.join(generation, "decision-input-catalog.json"), artifacts.decisionInputCatalog, "utf8"),
    writeFile(path.join(generation, "augment-stage-authority.json"), artifacts.augmentStageAuthority, "utf8"),
    writeFile(path.join(generation, "runtime-catalog-overlay.json"), artifacts.runtimeCatalogOverlay, "utf8"),
    writeFile(path.join(generation, "semantic-feature-index.json"), artifacts.semanticFeatureIndex, "utf8"),
  ]);
  if (timestamp) await utimes(generation, timestamp, timestamp);
  const relativeGeneration = `generated/${id}`;
  const candidate = {
    schema: "jcc-game-knowledge-candidate-profile-v1",
    season_id: "s18",
    patch_id: "s18_1",
    runtime_identity: runtimeIdentity,
    combined_fingerprint: id,
    bundle_path: `${relativeGeneration}/bundle.json`,
    bundle_sha256: sha256(artifacts.bundle),
    bundle_byte_size: Buffer.byteLength(artifacts.bundle),
    decision_input_catalog_path: `${relativeGeneration}/decision-input-catalog.json`,
    decision_input_catalog_sha256: sha256(artifacts.decisionInputCatalog),
    decision_input_catalog_byte_size: Buffer.byteLength(artifacts.decisionInputCatalog),
    augment_stage_authority_path: `${relativeGeneration}/augment-stage-authority.json`,
    augment_stage_authority_sha256: sha256(artifacts.augmentStageAuthority),
    augment_stage_authority_byte_size: Buffer.byteLength(artifacts.augmentStageAuthority),
    runtime_catalog_overlay_path: `${relativeGeneration}/runtime-catalog-overlay.json`,
    runtime_catalog_overlay_sha256: sha256(artifacts.runtimeCatalogOverlay),
    runtime_catalog_overlay_byte_size: Buffer.byteLength(artifacts.runtimeCatalogOverlay),
    semantic_feature_index_path: `${relativeGeneration}/semantic-feature-index.json`,
    semantic_feature_index_sha256: sha256(artifacts.semanticFeatureIndex),
    semantic_feature_index_byte_size: Buffer.byteLength(artifacts.semanticFeatureIndex),
  };
  const candidateFile = path.join(candidates, "candidate-profile.json");
  await writeFile(candidateFile, `${JSON.stringify(candidate)}\n`, "utf8");
  return { candidate, candidateFile, generation, artifacts, sourceIdentity };
}

const repoRoot = path.resolve(import.meta.dirname, "..");
const root = await mkdtemp(path.join(os.tmpdir(), "jcc-core-profile-store-"));
const generated = path.join(root, "generated", "a".repeat(64));
const candidates = path.join(root, "candidates");
await mkdir(generated, { recursive: true });
await mkdir(candidates, { recursive: true });

try {
  const runtimeIdentity = {
    schema: "jcc-game-knowledge-runtime-identity-v1",
    season_id: "s18",
    patch_id: "s18_1",
    game_mode_id: "jcc-mode18",
    package_id: "jcc-s18-s18_1",
    source_package_id: "jcc-mode18-s19-18.1.0",
    hard_data_manifest: "data/core-patches/jcc/jcc-mode18-s19-18.1.0/manifest.json",
    upstream_identity: {
      mode: "18",
      season: "19",
      version: "18.1.0",
      framework_name: "Mode18S19",
    },
  };
  const semanticFeatureIndex = `${JSON.stringify({
    schema: "jcc-semantic-feature-index-v1",
    identity: { season_id: "s18", patch_id: "s18_1", core_profile_id: "a".repeat(64) },
    entities: [],
  })}\n`;
  const bundle = `${JSON.stringify({
    schema: "jcc-game-knowledge-bundle-v1",
    combined_fingerprint: "a".repeat(64),
    profile: { season_id: "s18", patch_id: "s18_1" },
    patch: { activation_blockers: [] },
    runtime_identity: runtimeIdentity,
    semantic_feature_index: JSON.parse(semanticFeatureIndex),
  })}\n`;
  const bundlePath = path.join(generated, "bundle.json");
  await writeFile(bundlePath, bundle, "utf8");
  const sourceIdentity = {
    season_id: "s18",
    active_patch_id: "s18_1",
    core_profile_id: "a".repeat(64),
    hard_data_source_ref: `core_profile_hard_data_manifest:${runtimeIdentity.hard_data_manifest}`,
    hard_data_manifest_fingerprint: "f".repeat(64),
    catalog_source_fingerprint: "e".repeat(64),
  };
  const decisionInputCatalog = `${JSON.stringify({
    schema: "jcc-decision-input-catalog-v1",
    source_identity: sourceIdentity,
    entities: [],
    aliases: [],
  })}\n`;
  const decisionInputCatalogPath = path.join(generated, "decision-input-catalog.json");
  await writeFile(decisionInputCatalogPath, decisionInputCatalog, "utf8");
  const augmentStageAuthority = `${JSON.stringify({
    schema: "jcc-decision-input-augment-stage-authority-v1",
    source_identity: sourceIdentity,
    augment_stage_bindings: [],
    generated_augments: [],
  })}\n`;
  const augmentStageAuthorityPath = path.join(generated, "augment-stage-authority.json");
  await writeFile(augmentStageAuthorityPath, augmentStageAuthority, "utf8");
  const runtimeCatalogOverlay = `${JSON.stringify({
    schema: "jcc-runtime-catalog-overlay-v1",
    source_identity: sourceIdentity,
    champions_by_id: {},
    items_by_id: {},
  })}\n`;
  const runtimeCatalogOverlayPath = path.join(generated, "runtime-catalog-overlay.json");
  await writeFile(runtimeCatalogOverlayPath, runtimeCatalogOverlay, "utf8");
  const semanticFeatureIndexPath = path.join(generated, "semantic-feature-index.json");
  await writeFile(semanticFeatureIndexPath, semanticFeatureIndex, "utf8");
  const candidate = {
    schema: "jcc-game-knowledge-candidate-profile-v1",
    season_id: "s18",
    patch_id: "s18_1",
    runtime_identity: runtimeIdentity,
    combined_fingerprint: "a".repeat(64),
    bundle_path: `generated/${"a".repeat(64)}/bundle.json`,
    bundle_sha256: sha256(bundle),
    bundle_byte_size: Buffer.byteLength(bundle),
    decision_input_catalog_path: `generated/${"a".repeat(64)}/decision-input-catalog.json`,
    decision_input_catalog_sha256: sha256(decisionInputCatalog),
    decision_input_catalog_byte_size: Buffer.byteLength(decisionInputCatalog),
    augment_stage_authority_path: `generated/${"a".repeat(64)}/augment-stage-authority.json`,
    augment_stage_authority_sha256: sha256(augmentStageAuthority),
    augment_stage_authority_byte_size: Buffer.byteLength(augmentStageAuthority),
    runtime_catalog_overlay_path: `generated/${"a".repeat(64)}/runtime-catalog-overlay.json`,
    runtime_catalog_overlay_sha256: sha256(runtimeCatalogOverlay),
    runtime_catalog_overlay_byte_size: Buffer.byteLength(runtimeCatalogOverlay),
    semantic_feature_index_path: `generated/${"a".repeat(64)}/semantic-feature-index.json`,
    semantic_feature_index_sha256: sha256(semanticFeatureIndex),
    semantic_feature_index_byte_size: Buffer.byteLength(semanticFeatureIndex),
    activation_blockers: [],
  };
  const candidateFile = path.join(candidates, "candidate-profile.json");
  await writeFile(candidateFile, `${JSON.stringify(candidate)}\n`, "utf8");
  await promoteGameKnowledgeCandidate({
    knowledgeRoot: root,
    candidateProfilePath: candidateFile,
    expectedCoreProfileId: candidate.combined_fingerprint,
  });
  const loaded = loadActiveGameKnowledgeProfileSync({ knowledgeRoot: root });
  assert.equal(loaded.active.core_profile_id, candidate.combined_fingerprint);
  assert.deepEqual(loaded.runtimeIdentity, runtimeIdentity);
  assert.equal(loaded.identityAuthority, "core_profile");
  assert.equal(loaded.decisionInputCatalogFile, decisionInputCatalogPath);
  assert.equal(loaded.augmentStageAuthorityFile, augmentStageAuthorityPath);
  assert.equal(loaded.runtimeCatalogOverlayFile, runtimeCatalogOverlayPath);
  assert.equal(loaded.semanticFeatureIndexFile, semanticFeatureIndexPath);
  await writeFile(runtimeCatalogOverlayPath, `${runtimeCatalogOverlay.trim()}\n${"x".repeat(32)}`, "utf8");
  assert.throws(
    () => loadActiveGameKnowledgeProfileSync({ knowledgeRoot: root }),
    /byte size|hash/,
    "an unchanged active pointer must not hide an in-place artifact mutation behind the process cache",
  );
  await writeFile(runtimeCatalogOverlayPath, runtimeCatalogOverlay, "utf8");
  assert.equal(loadActiveGameKnowledgeProfileSync({ knowledgeRoot: root }).active.core_profile_id, candidate.combined_fingerprint);

  const activeBeforeRollbackExercise = await readFile(path.join(root, "active-profile.json"));
  const rollbackCandidateId = "b".repeat(64);
  const rollbackCandidate = await writeCandidateGeneration(root, rollbackCandidateId, runtimeIdentity);
  await promoteGameKnowledgeCandidate({
    knowledgeRoot: root,
    candidateProfilePath: rollbackCandidate.candidateFile,
    expectedCoreProfileId: rollbackCandidateId,
  });
  assert.equal(loadActiveGameKnowledgeProfileSync({ knowledgeRoot: root }).active.core_profile_id, rollbackCandidateId);
  await assert.rejects(
    () => restoreActiveGameKnowledgeProfile({
      knowledgeRoot: root,
      previousActiveProfileBytes: activeBeforeRollbackExercise,
      expectedCurrentCoreProfileId: "c".repeat(64),
    }),
    /changed before rollback/,
    "rollback must not overwrite an active pointer that no longer matches the failed promotion",
  );
  assert.equal(loadActiveGameKnowledgeProfileSync({ knowledgeRoot: root }).active.core_profile_id, rollbackCandidateId);
  await restoreActiveGameKnowledgeProfile({
    knowledgeRoot: root,
    previousActiveProfileBytes: activeBeforeRollbackExercise,
    expectedCurrentCoreProfileId: rollbackCandidateId,
  });
  assert.deepEqual(await readFile(path.join(root, "active-profile.json")), activeBeforeRollbackExercise);
  assert.equal(loadActiveGameKnowledgeProfileSync({ knowledgeRoot: root }).active.core_profile_id, candidate.combined_fingerprint);
  await writeFile(candidateFile, `${JSON.stringify(candidate)}\n`, "utf8");

  const activeBeforeBlockedPromotion = await readFile(path.join(root, "active-profile.json"));
  const immutableBlockers = ["compatible_master_plus_rankings_unavailable"];
  const blockedBundle = `${JSON.stringify({
    schema: "jcc-game-knowledge-bundle-v1",
    combined_fingerprint: "a".repeat(64),
    profile: { season_id: "s18", patch_id: "s18_1" },
    patch: { activation_blockers: immutableBlockers },
    runtime_identity: runtimeIdentity,
  })}\n`;
  await writeFile(bundlePath, blockedBundle, "utf8");
  const blockedCandidate = {
    ...candidate,
    activation_blockers: immutableBlockers,
    bundle_sha256: sha256(blockedBundle),
    bundle_byte_size: Buffer.byteLength(blockedBundle),
  };
  await writeFile(candidateFile, `${JSON.stringify(blockedCandidate)}\n`, "utf8");
  await assert.rejects(
    () => promoteGameKnowledgeCandidate({ knowledgeRoot: root, candidateProfilePath: candidateFile, expectedCoreProfileId: candidate.combined_fingerprint }),
    /activation blockers/i,
  );
  assert.deepEqual(await readFile(path.join(root, "active-profile.json")), activeBeforeBlockedPromotion);
  await writeFile(candidateFile, `${JSON.stringify({ ...blockedCandidate, activation_blockers: [] })}\n`, "utf8");
  await assert.rejects(
    () => promoteGameKnowledgeCandidate({ knowledgeRoot: root, candidateProfilePath: candidateFile, expectedCoreProfileId: candidate.combined_fingerprint }),
    /activation blockers do not match the immutable bundle/i,
    "removing blockers only from the mutable candidate pointer must not permit promotion",
  );
  assert.deepEqual(await readFile(path.join(root, "active-profile.json")), activeBeforeBlockedPromotion);
  await writeFile(bundlePath, bundle, "utf8");
  await writeFile(candidateFile, `${JSON.stringify(candidate)}\n`, "utf8");

  await assert.rejects(
    () => promoteGameKnowledgeCandidate({
      knowledgeRoot: root,
      candidateProfilePath: candidateFile,
      expectedCoreProfileId: "b".repeat(64),
    }),
    /does not match expected/i,
  );
  await promoteGameKnowledgeCandidate({
    knowledgeRoot: root,
    candidateProfilePath: candidateFile,
    expectedCoreProfileId: candidate.combined_fingerprint,
  });

  const activeBefore = await readFile(path.join(root, "active-profile.json"));
  await writeFile(candidateFile, `${JSON.stringify({ ...candidate, bundle_sha256: "0".repeat(64) })}\n`, "utf8");
  await assert.rejects(() => promoteGameKnowledgeCandidate({ knowledgeRoot: root, candidateProfilePath: candidateFile, expectedCoreProfileId: candidate.combined_fingerprint }), /hash/);
  assert.deepEqual(await readFile(path.join(root, "active-profile.json")), activeBefore);

  await writeFile(candidateFile, `${JSON.stringify({ ...candidate, runtime_identity: undefined })}\n`, "utf8");
  await assert.rejects(
    () => promoteGameKnowledgeCandidate({ knowledgeRoot: root, candidateProfilePath: candidateFile, expectedCoreProfileId: candidate.combined_fingerprint }),
    /runtime identity must exist in both pointer and bundle/,
  );
  assert.deepEqual(await readFile(path.join(root, "active-profile.json")), activeBefore);

  await writeFile(candidateFile, `${JSON.stringify({
    ...candidate,
    runtime_identity: { ...runtimeIdentity, source_package_id: "wrong-source-package" },
  })}\n`, "utf8");
  await assert.rejects(
    () => promoteGameKnowledgeCandidate({ knowledgeRoot: root, candidateProfilePath: candidateFile, expectedCoreProfileId: candidate.combined_fingerprint }),
    /runtime identity mismatch/,
  );
  assert.deepEqual(await readFile(path.join(root, "active-profile.json")), activeBefore);
  await assert.rejects(() => promoteGameKnowledgeCandidate({
    knowledgeRoot: root,
    candidateProfilePath: path.join(root, "outside.json"),
    expectedCoreProfileId: candidate.combined_fingerprint,
  }), /escapes candidates root/);

  const retentionRoot = path.join(root, "retention-case");
  const retentionGenerated = path.join(retentionRoot, "generated");
  const retentionIds = {
    active: "1".repeat(64),
    candidate: "2".repeat(64),
    recentOne: "3".repeat(64),
    recentTwo: "4".repeat(64),
    expired: "5".repeat(64),
    leased: "6".repeat(64),
  };
  await mkdir(path.join(retentionRoot, "candidates"), { recursive: true });
  await writeFile(
    path.join(retentionRoot, "active-profile.json"),
    `${JSON.stringify({ core_profile_id: retentionIds.active })}\n`,
    "utf8",
  );
  await writeFile(
    path.join(retentionRoot, "candidates", "candidate-profile.json"),
    `${JSON.stringify({ combined_fingerprint: retentionIds.candidate })}\n`,
    "utf8",
  );
  const orderedRetentionIds = [
    retentionIds.expired,
    retentionIds.recentTwo,
    retentionIds.recentOne,
    retentionIds.candidate,
    retentionIds.active,
    retentionIds.leased,
  ];
  for (const [index, id] of orderedRetentionIds.entries()) {
    const directory = path.join(retentionGenerated, id);
    await mkdir(directory, { recursive: true });
    const timestamp = new Date(Date.UTC(2026, 0, index + 1));
    await utimes(directory, timestamp, timestamp);
  }
  const leaseFile = path.join(retentionRoot, "generation-leases.json");
  await writeFile(leaseFile, `${JSON.stringify({
    schema: "jcc-game-knowledge-generation-leases-v1",
    leases: [{
      core_profile_id: retentionIds.leased,
      ranking_overlay_id: "20260831-aaaaaaaaaaaaaaaaaaaaaaaa",
      recipe_generation_id: "7".repeat(64),
      match_session_id: "match-active",
      status: "active",
    }],
  })}\n`, "utf8");
  const generationLeases = await readGameKnowledgeGenerationLeases({ leaseFile });
  assert.equal(generationLeases[0].ranking_overlay_id, "20260831-aaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(generationLeases[0].recipe_generation_id, "7".repeat(64));
  const retention = await pruneGameKnowledgeGenerations({
    knowledgeRoot: retentionRoot,
    retainPrevious: 2,
    generationLeases,
  });
  assert.deepEqual(new Set(retention.retained), new Set([
    retentionIds.active,
    retentionIds.candidate,
    retentionIds.recentOne,
    retentionIds.recentTwo,
    retentionIds.leased,
  ]));
  assert.deepEqual(retention.removed, [retentionIds.expired]);
  assert.deepEqual(new Set(retention.current_profile_ids), new Set([retentionIds.active, retentionIds.candidate]), "Previous Core storage must not grant Ranking candidate protection");
  await assert.rejects(() => access(path.join(retentionGenerated, retentionIds.expired)));
  for (const id of retention.retained) await access(path.join(retentionGenerated, id));

  await writeFile(path.join(root, "active-profile.json"), `${JSON.stringify({
    ...candidate,
    decision_input_catalog_path: undefined,
  })}\n`, "utf8");
  assert.throws(() => loadActiveGameKnowledgeProfileSync({ knowledgeRoot: root }), /active core profile pointer is invalid/i);

  console.log(JSON.stringify({
    ok: true,
    schema: "jcc-game-knowledge-profile-store-verifier-v1",
    checked: [
      "valid candidate promotes through one active pointer",
      "low-level promotion requires an explicit expected identity",
      "identity mismatch leaves the active pointer byte-identical",
      "promotion validates the exact candidate identity before committing",
      "new S18-like candidate persists a complete runtime identity",
      "active loader verifies bundle identity, size, and hash",
      "active loader cache invalidates when an immutable artifact changes",
      "failed coordinated publication can restore the prior active pointer without stale cache state",
      "rollback refuses to overwrite an independently changed active pointer",
      "new candidates fail closed when runtime identity is missing or mismatched",
    "candidates with release activation blockers cannot replace the active profile",
    "mutable candidate pointers cannot remove blockers declared by the immutable bundle",
      "active profiles fail closed when a compiled decision artifact is missing",
      "invalid candidate leaves last-known-good pointer byte-identical",
      "candidate path escape fails closed",
      "generation retention protects active, candidate, and active-match leases while keeping only two prior generations"
    ]
  }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
