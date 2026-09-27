import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";

export const RANKING_MAINTENANCE_PREPARATION_SCHEMA = "jcc-ranking-maintenance-preparation-v1";

function text(value) {
  return String(value ?? "").trim();
}

export function rankingMaintenancePreparationIdentity(pointer = {}) {
  return {
    schema: text(pointer.schema),
    status: text(pointer.status),
    preparation_revision: text(pointer.preparation_revision),
    core_profile_id: text(pointer.core_profile_id),
    generation_id: text(pointer.generation_id),
    recipe_generation_id: text(pointer.recipe_generation_id),
    content_sha256: text(pointer.content_sha256),
    expected_active_generation_id: text(
      pointer.expected_active_ranking_generation_id ?? pointer.expected_active_generation_id,
    ) || null,
    expected_active_ranking_generation_id: text(
      pointer.expected_active_ranking_generation_id ?? pointer.expected_active_generation_id,
    ) || null,
    expected_active_recipe_generation_id: text(pointer.expected_active_recipe_generation_id) || null,
    expected_active_stat_date: text(pointer.expected_active_stat_date) || null,
    expected_active_core_profile_id: text(pointer.expected_active_core_profile_id) || null,
  };
}

export function createRankingMaintenancePreparationPointer(fields = {}) {
  return {
    ...fields,
    schema: RANKING_MAINTENANCE_PREPARATION_SCHEMA,
    status: "maintenance_prepared",
    preparation_revision: randomUUID(),
    expected_active_generation_id: text(
      fields.expected_active_ranking_generation_id ?? fields.expected_active_generation_id,
    ) || null,
    expected_active_ranking_generation_id: text(
      fields.expected_active_ranking_generation_id ?? fields.expected_active_generation_id,
    ) || null,
    expected_active_recipe_generation_id: text(fields.expected_active_recipe_generation_id) || null,
    expected_active_stat_date: text(fields.expected_active_stat_date) || null,
    expected_active_core_profile_id: text(fields.expected_active_core_profile_id) || null,
    prepared_at: new Date().toISOString(),
  };
}

export function rankingMaintenanceExpectedActiveClosure(pointer = {}) {
  const identity = rankingMaintenancePreparationIdentity(pointer);
  return {
    ranking_generation_id: identity.expected_active_ranking_generation_id,
    recipe_generation_id: identity.expected_active_recipe_generation_id,
    stat_date: identity.expected_active_stat_date,
    core_profile_id: identity.expected_active_core_profile_id,
  };
}

export function activeClosureMatchesRankingMaintenanceExpectation(pointer = {}, closure = {}) {
  const expected = rankingMaintenanceExpectedActiveClosure(pointer);
  const available = closure?.availability === "available" && closure?.closure_status !== "invalid";
  const actual = {
    ranking_generation_id: available ? text(closure.ranking_generation_id) || null : null,
    recipe_generation_id: available ? text(closure.recipe_generation_id) || null : null,
    stat_date: available ? text(closure.stat_date) || null : null,
    core_profile_id: available ? text(closure.core_profile_id) || null : null,
  };
  return Object.keys(expected).every((key) => expected[key] === actual[key]);
}

export function assertRankingMaintenancePreparation(pointer = {}, expected = {}) {
  const actualIdentity = rankingMaintenancePreparationIdentity(pointer);
  const expectedIdentity = rankingMaintenancePreparationIdentity(expected);
  if (actualIdentity.schema !== RANKING_MAINTENANCE_PREPARATION_SCHEMA
    || actualIdentity.status !== "maintenance_prepared"
    || !actualIdentity.preparation_revision
    || actualIdentity.preparation_revision !== expectedIdentity.preparation_revision
    || actualIdentity.core_profile_id !== expectedIdentity.core_profile_id
    || actualIdentity.generation_id !== expectedIdentity.generation_id
    || actualIdentity.recipe_generation_id !== expectedIdentity.recipe_generation_id
    || actualIdentity.content_sha256 !== expectedIdentity.content_sha256
    || actualIdentity.expected_active_ranking_generation_id !== expectedIdentity.expected_active_ranking_generation_id
    || actualIdentity.expected_active_recipe_generation_id !== expectedIdentity.expected_active_recipe_generation_id
    || actualIdentity.expected_active_stat_date !== expectedIdentity.expected_active_stat_date
    || actualIdentity.expected_active_core_profile_id !== expectedIdentity.expected_active_core_profile_id) {
    throw new Error("ranking maintenance preparation was superseded before publication");
  }
  return pointer;
}

export async function readRankingMaintenancePreparation(pointerFile) {
  return JSON.parse(await readFile(pointerFile, "utf8"));
}

export async function assertCurrentRankingMaintenancePreparation(pointerFile, expected) {
  const current = await readRankingMaintenancePreparation(pointerFile);
  return assertRankingMaintenancePreparation(current, expected);
}

export async function removeRankingMaintenancePreparationIfCurrent(pointerFile, expected) {
  await assertCurrentRankingMaintenancePreparation(pointerFile, expected);
  await rm(pointerFile, { force: false });
  return true;
}
