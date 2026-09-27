import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntimePaths } from "../ui/electron/runtime-state-store.js";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sourceManifest({ packageId, mode, season, version, modeName, patchId }) {
  return { packageId, mode, season, version, modeName, runtime_patch_id: patchId };
}

const repoRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-core-runtime-identity-"));
try {
  const knowledgeRoot = path.join(repoRoot, "data", "game-knowledge", "jcc");
  const fingerprint = "c".repeat(64);
  const coreManifestRelative = "data/core-patches/jcc/jcc-mode18-s19-18.1.0/manifest.json";
  const coreRuntimeIdentity = {
    schema: "jcc-game-knowledge-runtime-identity-v1",
    season_id: "s18",
    patch_id: "s18_1",
    game_mode_id: "jcc-mode18",
    package_id: "jcc-s18-s18_1",
    source_package_id: "jcc-mode18-s19-18.1.0",
    hard_data_manifest: coreManifestRelative,
    upstream_identity: {
      mode: "18",
      season: "19",
      version: "18.1.0",
      framework_name: "Mode18S19",
    },
  };
  await writeJson(path.join(repoRoot, coreManifestRelative), sourceManifest({
    packageId: coreRuntimeIdentity.source_package_id,
    mode: "18",
    season: "19",
    version: "18.1.0",
    modeName: "Mode18S19",
    patchId: "s18_1",
  }));

  const semanticFeatureIndex = {
    schema: "jcc-semantic-feature-index-v1",
    identity: { season_id: "s18", patch_id: "s18_1", core_profile_id: fingerprint },
    entities: [],
  };
  const bundleText = `${JSON.stringify({
    schema: "jcc-game-knowledge-bundle-v1",
    combined_fingerprint: fingerprint,
    profile: { season_id: "s18", patch_id: "s18_1" },
    runtime_identity: coreRuntimeIdentity,
    semantic_feature_index: semanticFeatureIndex,
  })}\n`;
  const bundleRelative = `generated/${fingerprint}/bundle.json`;
  await writeFile(path.join(knowledgeRoot, bundleRelative), bundleText, { encoding: "utf8", flag: "wx" }).catch(async (error) => {
    if (error.code !== "ENOENT") throw error;
    await mkdir(path.dirname(path.join(knowledgeRoot, bundleRelative)), { recursive: true });
    await writeFile(path.join(knowledgeRoot, bundleRelative), bundleText, "utf8");
  });
  const compiledSourceIdentity = {
    season_id: "s18",
    active_patch_id: "s18_1",
    core_profile_id: fingerprint,
    hard_data_source_ref: `core_profile_hard_data_manifest:${coreManifestRelative}`,
  };
  const decisionInputCatalogText = `${JSON.stringify({
    schema: "jcc-decision-input-catalog-v1",
    source_identity: compiledSourceIdentity,
    entities: [],
    aliases: [],
  })}\n`;
  const decisionInputCatalogRelative = `generated/${fingerprint}/decision-input-catalog.json`;
  await writeFile(path.join(knowledgeRoot, decisionInputCatalogRelative), decisionInputCatalogText, "utf8");
  const augmentStageAuthorityText = `${JSON.stringify({
    schema: "jcc-decision-input-augment-stage-authority-v1",
    source_identity: compiledSourceIdentity,
    augment_stage_bindings: [],
    generated_augments: [],
  })}\n`;
  const augmentStageAuthorityRelative = `generated/${fingerprint}/augment-stage-authority.json`;
  await writeFile(path.join(knowledgeRoot, augmentStageAuthorityRelative), augmentStageAuthorityText, "utf8");
  const runtimeCatalogOverlayText = `${JSON.stringify({
    schema: "jcc-runtime-catalog-overlay-v1",
    source_identity: compiledSourceIdentity,
    champions_by_id: {},
    items_by_id: {},
  })}\n`;
  const runtimeCatalogOverlayRelative = `generated/${fingerprint}/runtime-catalog-overlay.json`;
  await writeFile(path.join(knowledgeRoot, runtimeCatalogOverlayRelative), runtimeCatalogOverlayText, "utf8");
  const semanticFeatureIndexText = `${JSON.stringify(semanticFeatureIndex)}\n`;
  const semanticFeatureIndexRelative = `generated/${fingerprint}/semantic-feature-index.json`;
  await writeFile(path.join(knowledgeRoot, semanticFeatureIndexRelative), semanticFeatureIndexText, "utf8");
  await writeJson(path.join(knowledgeRoot, "active-profile.json"), {
    schema: "jcc-game-knowledge-active-profile-v1",
    core_profile_id: fingerprint,
    season_id: "s18",
    patch_id: "s18_1",
    runtime_identity: coreRuntimeIdentity,
    bundle_path: bundleRelative,
    bundle_sha256: sha256(bundleText),
    bundle_byte_size: Buffer.byteLength(bundleText),
    decision_input_catalog_path: decisionInputCatalogRelative,
    decision_input_catalog_sha256: sha256(decisionInputCatalogText),
    decision_input_catalog_byte_size: Buffer.byteLength(decisionInputCatalogText),
    augment_stage_authority_path: augmentStageAuthorityRelative,
    augment_stage_authority_sha256: sha256(augmentStageAuthorityText),
    augment_stage_authority_byte_size: Buffer.byteLength(augmentStageAuthorityText),
    runtime_catalog_overlay_path: runtimeCatalogOverlayRelative,
    runtime_catalog_overlay_sha256: sha256(runtimeCatalogOverlayText),
    runtime_catalog_overlay_byte_size: Buffer.byteLength(runtimeCatalogOverlayText),
    semantic_feature_index_path: semanticFeatureIndexRelative,
    semantic_feature_index_sha256: sha256(semanticFeatureIndexText),
    semantic_feature_index_byte_size: Buffer.byteLength(semanticFeatureIndexText),
  });

  const fallbackManifestRelative = "data/core-patches/jcc/legacy-s17/manifest.json";
  await writeJson(path.join(repoRoot, fallbackManifestRelative), sourceManifest({
    packageId: "legacy-source-s17",
    mode: "17",
    season: "18",
    version: "17.17.8",
    modeName: "Mode17S18",
    patchId: "s17_8",
  }));
  const corePaths = createRuntimePaths(repoRoot, { dataRoot: path.join(repoRoot, ".runtime") });
  assert.equal(corePaths.activeRuntimeIdentityAuthority, "core_profile");
  assert.equal(corePaths.activeSeasonId, "s18");
  assert.equal(corePaths.activePatchId, "s18_1");
  assert.equal(corePaths.activePackageId, "jcc-s18-s18_1");
  assert.equal(corePaths.activeSourcePackageId, "jcc-mode18-s19-18.1.0");
  assert.equal(corePaths.activeHardDataManifest, coreManifestRelative);
  assert.equal(corePaths.activeDecisionInputCatalogFile, path.join(knowledgeRoot, decisionInputCatalogRelative));
  assert.equal(corePaths.activeDecisionInputAugmentStageAuthorityFile, path.join(knowledgeRoot, augmentStageAuthorityRelative));
  assert.equal(corePaths.activeRuntimeCatalogOverlayFile, path.join(knowledgeRoot, runtimeCatalogOverlayRelative));
  assert.equal(corePaths.activeSemanticFeatureIndexFile, path.join(knowledgeRoot, semanticFeatureIndexRelative));
  assert.equal(corePaths.baseGameRulesFile, undefined);
  assert.equal(corePaths.seasonNormalRulesFile, undefined);
  assert.equal(corePaths.seasonSpecialRulesFile, undefined);
  assert.equal(corePaths.legacyBaseGameRuleFixtureFile, undefined);
  assert.equal(corePaths.legacySeasonNormalRuleFixtureFile, undefined);
  assert.equal(corePaths.legacySeasonSpecialRuleFixtureFile, undefined);

  await writeJson(path.join(repoRoot, coreManifestRelative), sourceManifest({
    packageId: "mismatched-source-package",
    mode: "18",
    season: "19",
    version: "18.1.0",
    modeName: "Mode18S19",
    patchId: "s18_1",
  }));
  assert.throws(
    () => createRuntimePaths(repoRoot, { dataRoot: path.join(repoRoot, ".runtime") }),
    /packageId does not match runtime identity/,
  );
  await writeJson(path.join(repoRoot, coreManifestRelative), sourceManifest({
    packageId: coreRuntimeIdentity.source_package_id,
    mode: "18",
    season: "19",
    version: "18.1.0",
    modeName: "Mode18S19",
    patchId: "s18_2",
  }));
  assert.throws(
    () => createRuntimePaths(repoRoot, { dataRoot: path.join(repoRoot, ".runtime") }),
    /runtime_patch_id does not match runtime identity/,
  );
  await writeJson(path.join(repoRoot, coreManifestRelative), sourceManifest({
    packageId: coreRuntimeIdentity.source_package_id,
    mode: "18",
    season: "19",
    version: "18.1.1",
    modeName: "Mode18S19",
    patchId: "s18_1",
  }));
  assert.throws(
    () => createRuntimePaths(repoRoot, { dataRoot: path.join(repoRoot, ".runtime") }),
    /version does not match runtime identity/,
  );

  await writeJson(path.join(repoRoot, "data", "runtime", "jcc", "runtime-season-module-contract.json"), {
    schema: "jcc-runtime-season-module-contract-v1",
    active_season: {
      season_id: "s17",
      active_patch_id: "s17_8",
      game_mode_id: "jcc-mode17",
      package_id: "jcc-s17-s17_8",
      source_package_id: "legacy-source-s17",
      hard_data_manifest: fallbackManifestRelative,
      upstream_identity: {
        mode: "17",
        season: "18",
        version: "17.17.8",
        framework_name: "Mode17S18",
      },
    },
  });
  await unlink(path.join(knowledgeRoot, "active-profile.json"));
  assert.throws(
    () => createRuntimePaths(repoRoot, { dataRoot: path.join(repoRoot, ".runtime") }),
    /Active Core Profile is missing/,
  );

  console.log(JSON.stringify({
    ok: true,
    schema: "jcc-core-profile-runtime-identity-verifier-v1",
    checked: [
      "S18-like active Core Profile is selected without reading a legacy season contract",
      "Core Profile source package, patch, and upstream identity mismatches fail closed",
      "missing Core Profile fails closed instead of selecting a legacy season identity",
      "legacy rule fallback paths are absent",
    ],
  }, null, 2));
} finally {
  await rm(repoRoot, { recursive: true, force: true });
}
