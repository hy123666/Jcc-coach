#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { createRuntimePaths } from "../ui/electron/runtime-state-store.js";
import { resolveHardDataTarget, validateHardDataTarget } from "./jcc_hard_data_target.mjs";
import { normalizedArtifactCount } from "./jcc_hard_data_artifact_counts.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const runtimePaths = createRuntimePaths(repoRoot);

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function assertUniqueIds(rows, label) {
  assert.ok(Array.isArray(rows), `${label} must be an array`);
  const ids = rows.map((row) => String(row?.id || "").trim());
  assert.ok(ids.every(Boolean), `${label} rows must have ids`);
  assert.equal(new Set(ids).size, ids.length, `${label} ids must be unique`);
}

function assertIdentityMatches(manifest, contentManifest) {
  if (!contentManifest?.identity) return;
  const expected = manifest.identity || {};
  for (const key of ["season_id", "patch_id", "mode_id"]) {
    assert.equal(contentManifest.identity[key], expected[key], `hard-data identity mismatch for ${key}`);
  }
}

async function verifyContentAddressedGeneration(target, manifest) {
  const contentPath = path.join(target.packageDir, manifest.hard_data_manifest?.file || "hard-data-manifest.json");
  const content = await readJson(contentPath);
  assert.equal(content.schema, "jcc-hard-data-content-manifest-v1");
  assert.equal(content.deterministic, true);
  assert.equal(content.rankings_included, false, "Core hard data must not embed rankings");
  assertIdentityMatches(manifest, content);

  const requiredFiles = [
    "normalized/champions.json",
    "normalized/chess_variants.json",
    "normalized/traits.json",
    "normalized/items.json",
    "normalized/augments.json",
    "normalized/season_mechanics.json",
    "normalized/per_match_variables.json",
    "indexes/entity_alias_gateway.json",
    "indexes/champion_role_profile.json",
    "indexes/component_to_item_candidates.json",
    "indexes/trait_breakpoints.json",
    "indexes/trait_unit_matrix.json",
    "indexes/augment_stage_authority.json",
    "runtime-catalog-overlay.json",
  ];
  for (const relativePath of requiredFiles) {
    assert.ok(content.files?.[relativePath], `hard-data manifest is missing ${relativePath}`);
  }
  assert.ok(
    Object.keys(content.files || {}).every((relativePath) => !relativePath.startsWith("rankings/") && !relativePath.includes("ranking-overlay")),
    "Core hard data must not contain ranking artifacts",
  );
  for (const [key, value] of Object.entries(content.counts || {})) {
    assert.ok(Number.isInteger(value) && value >= 0, `hard-data count ${key} must be a nonnegative integer`);
  }

  const [champions, chessVariants, traits, items, augments, perMatchVariables, rewardTables] = await Promise.all([
    readJson(path.join(target.packageDir, "normalized/champions.json")),
    readJson(path.join(target.packageDir, "normalized/chess_variants.json")),
    readJson(path.join(target.packageDir, "normalized/traits.json")),
    readJson(path.join(target.packageDir, "normalized/items.json")),
    readJson(path.join(target.packageDir, "normalized/augments.json")),
    readJson(path.join(target.packageDir, "normalized/per_match_variables.json")),
    readJson(path.join(target.packageDir, "normalized/reward_tables.json")),
  ]);
  for (const [rows, label] of [
    [champions, "champions"],
    [chessVariants, "chess variants"],
    [traits, "traits"],
    [items, "items"],
    [augments, "augments"],
  ]) assertUniqueIds(rows, label);

  assert.equal(champions.length, content.counts.champions);
  assert.equal(chessVariants.length, content.counts.chess_variants);
  assert.equal(traits.length, content.counts.traits);
  assert.equal(items.length, content.counts.items);
  assert.equal(augments.length, content.counts.augments);
  assert.equal(
    normalizedArtifactCount("reward_tables", rewardTables),
    content.counts.reward_tables,
    "reward-table manifest count must include entity, season, and supplemental tables",
  );
  assert.equal(perMatchVariables?.identity?.season_id, manifest.identity?.season_id);
  assert.equal(perMatchVariables?.identity?.patch_id, manifest.identity?.patch_id);

  const traitIds = new Set(traits.map((trait) => String(trait.id)));
  for (const champion of champions) {
    for (const trait of champion.traits || []) {
      if (trait.id != null) assert.ok(traitIds.has(String(trait.id)), `${champion.name} references unknown trait ${trait.id}`);
    }
  }

  return {
    generation_id: target.generationId,
    files: Object.keys(content.files).length,
    counts: content.counts,
  };
}

async function verifyArchivedLegacyPackage(target, manifest) {
  const content = await readJson(path.join(target.packageDir, "hard-data-manifest.json"));
  assert.equal(content.runtime_patch_id, manifest.runtime_patch_id);
  assert.ok(Number(content.counts?.champions) > 0);
  assert.ok(Number(content.counts?.traits) > 0);
  assert.ok(Number(content.counts?.items) > 0);
  assert.ok(Number(content.counts?.augments) > 0);
  return {
    generation_id: null,
    archived_legacy_package: manifest.packageId,
    counts: content.counts,
  };
}

async function main() {
  const target = resolveHardDataTarget({
    repoRoot,
    activeManifest: runtimePaths.activeHardDataManifest,
    argv: process.argv.slice(2),
    allowCandidate: true,
  });
  const manifest = await validateHardDataTarget(target);
  const result = target.generationId
    ? await verifyContentAddressedGeneration(target, manifest)
    : await verifyArchivedLegacyPackage(target, manifest);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    target: target.kind,
    season_id: manifest.identity?.season_id || null,
    patch_id: manifest.identity?.patch_id || manifest.runtime_patch_id,
    ...result,
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
