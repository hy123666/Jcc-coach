#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  activeClosureMatchesRankingMaintenanceExpectation,
  assertCurrentRankingMaintenancePreparation,
  createRankingMaintenancePreparationPointer,
  removeRankingMaintenancePreparationIfCurrent,
} from "./jcc_ranking_maintenance_preparation.mjs";

const root = await mkdtemp(path.join(tmpdir(), "jcc-ranking-preparation-"));
const pointerFile = path.join(root, "maintenance.json");
const writePointer = (value) => writeFile(pointerFile, `${JSON.stringify(value)}\n`, "utf8");

const preparationA = createRankingMaintenancePreparationPointer({
  core_profile_id: "a".repeat(64),
  generation_id: `20260831-${"a".repeat(24)}`,
  recipe_generation_id: "b".repeat(64),
  content_sha256: "c".repeat(64),
  expected_active_generation_id: `20260830-${"d".repeat(24)}`,
  expected_active_recipe_generation_id: "2".repeat(64),
  expected_active_stat_date: "20260830",
  expected_active_core_profile_id: "a".repeat(64),
});
await writePointer(preparationA);
await assertCurrentRankingMaintenancePreparation(pointerFile, preparationA);
assert.equal(activeClosureMatchesRankingMaintenanceExpectation(preparationA, {
  availability: "available",
  closure_status: "available",
  ranking_generation_id: preparationA.expected_active_ranking_generation_id,
  recipe_generation_id: preparationA.expected_active_recipe_generation_id,
  stat_date: preparationA.expected_active_stat_date,
  core_profile_id: preparationA.expected_active_core_profile_id,
}), true);
assert.equal(activeClosureMatchesRankingMaintenanceExpectation(preparationA, {
  availability: "available",
  closure_status: "available",
  ranking_generation_id: preparationA.expected_active_ranking_generation_id,
  recipe_generation_id: "3".repeat(64),
  stat_date: preparationA.expected_active_stat_date,
  core_profile_id: preparationA.expected_active_core_profile_id,
}), false, "a recipe-only Active advance must invalidate the prepared publication CAS");

const preparationB = createRankingMaintenancePreparationPointer({
  ...preparationA,
  generation_id: `20260831-${"e".repeat(24)}`,
  recipe_generation_id: "f".repeat(64),
  content_sha256: "1".repeat(64),
});
await writePointer(preparationB);
await assert.rejects(
  () => assertCurrentRankingMaintenancePreparation(pointerFile, preparationA),
  /superseded before publication/,
);
await assert.rejects(
  () => removeRankingMaintenancePreparationIfCurrent(pointerFile, preparationA),
  /superseded before publication/,
);
await assertCurrentRankingMaintenancePreparation(pointerFile, preparationB);
await removeRankingMaintenancePreparationIfCurrent(pointerFile, preparationB);

console.log(JSON.stringify({ ok: true, verifier: "jcc-ranking-maintenance-preparation" }, null, 2));
