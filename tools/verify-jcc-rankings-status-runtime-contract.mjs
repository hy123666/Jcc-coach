#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const originalRuntimeDataRoot = path.resolve(process.env.JCC_RUNTIME_DATA_DIR || path.join(root, ".jcc-runtime-data"));
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-rankings-status-contract-"));
const runtimeServiceSource = await readFile(path.join(root, "ui/electron/runtime-service.js"), "utf8");

function moduleUrl(file) {
  return `${pathToFileURL(path.resolve(root, file)).href}?rankings-status=${Date.now()}`;
}

const service = await import(moduleUrl("ui/electron/runtime-service.js"));
const daemon = await import(moduleUrl("ui/electron/runtime-daemon.js"));
service.configureRuntimeServicePaths({ dataRoot: tempRoot });
service.setRuntimeServiceState({
  schema: "jcc-ui-runtime-state-v1",
  daily_session: { status: "active", mode: "daily_chat", generation: 1 },
  match_session: { status: "idle", match_session_id: null },
  response_task: { status: "idle", response_task_id: null, revision: 0 },
  response_task_revision: 0,
});

try {
  assert.equal(typeof service.executeRankingsUpdate, "function", "runtime service must export the testable rankings update workflow");
  assert.equal(
    typeof service.selectRankingSemanticMaintenanceBaseline,
    "function",
    "runtime service must expose semantic-maintenance baseline recovery for interrupted updates",
  );
  const semanticIdentity = {
    runtime_season_id: "s18",
    active_patch_id: "s18_1",
    game_mode_id: "jcc-mode18",
    core_profile_id: "a".repeat(64),
    hard_data_manifest_fingerprint: "b".repeat(64),
    catalog_source_fingerprint: "c".repeat(64),
    battle_type: "31",
    lineup_version_id: "v6",
    ranking_set_id: "18",
  };
  const preparedSemanticIndex = {
    stat_date: "20260829",
    source_identity: semanticIdentity,
    tiers: { "0": { lineup_candidates: [{ lineup_group_id: "lineup-a" }] } },
  };
  const currentWithoutAnnotations = structuredClone(preparedSemanticIndex);
  const previousWithAnnotations = {
    ...structuredClone(preparedSemanticIndex),
    stat_date: "20260828",
    tiers: {
      "0": {
        lineup_candidates: [{
          lineup_group_id: "lineup-a",
          semantic_annotation: { lineup_id: "lineup-a" },
        }],
      },
    },
  };
  assert.equal(
    service.selectRankingSemanticMaintenanceBaseline(preparedSemanticIndex, [
      currentWithoutAnnotations,
      previousWithAnnotations,
    ]),
    previousWithAnnotations,
    "an interrupted current generation without annotations must fall back to the compatible annotated previous generation",
  );
  assert.equal(
    service.selectRankingSemanticMaintenanceBaseline(preparedSemanticIndex, [{
      ...previousWithAnnotations,
      source_identity: { ...semanticIdentity, ranking_set_id: "foreign" },
    }]),
    null,
    "semantic maintenance must never reuse annotations across ranking identities",
  );
  assert.equal(typeof service.rankingCapabilityStatusFromAudit, "function", "runtime must expose ranking capability status classification");
  const partialRecipeAudit = service.rankingCapabilityStatusFromAudit({
    status: "partial",
    strength_status: "available",
    recipe_status: "partial",
    warnings: [{ reason: "winning_recipe_count_below_minimum" }],
    failures: [],
  });
  assert.deepEqual(partialRecipeAudit, {
    overall_status: "ready",
    strength_status: "available",
    recipe_status: "partial",
    hero_status: "available",
    item_status: "available",
    roster_status: "available",
    semantic_maintenance_status: "unknown",
    full_ranking_overlay_available: false,
    blocking: false,
    recipe_source_lag: false,
  }, "a non-blocking partial recipe domain must not degrade the overall Ranking readiness");
  const sourceLagAudit = service.rankingCapabilityStatusFromAudit({
    status: "partial",
    strength_status: "available",
    recipe_status: "available",
    warnings: [{ reason: "lineup_date_differs_from_snapshot" }],
    failures: [],
  });
  assert.equal(sourceLagAudit.overall_status, "ready_with_source_lag");
  assert.equal(sourceLagAudit.recipe_status, "available");
  assert.equal(sourceLagAudit.recipe_source_lag, true);
  const partialHeroAudit = service.rankingCapabilityStatusFromAudit({
    status: "partial",
    strength_status: "available",
    recipe_status: "available",
    warnings: [{ reason: "hero_equip_ranking_partial_failure" }],
    failures: [],
  });
  assert.equal(partialHeroAudit.overall_status, "ready");
  assert.equal(partialHeroAudit.hero_status, "partial");
  assert.equal(partialHeroAudit.strength_status, "available");
  const blockingAudit = service.rankingCapabilityStatusFromAudit({
    status: "fail",
    strength_status: "unavailable",
    recipe_status: "unavailable",
    warnings: [],
    failures: [{ reason: "trait_rank_below_minimum" }],
  });
  assert.equal(blockingAudit.overall_status, "unavailable");
  assert.equal(blockingAudit.blocking, true);
  assert.equal(blockingAudit.strength_status, "unavailable");
  const strengthUnavailableWithoutFailures = service.rankingCapabilityStatusFromAudit({
    status: "partial",
    strength_status: "unavailable",
    recipe_status: "available",
    warnings: [],
    failures: [],
  });
  assert.equal(strengthUnavailableWithoutFailures.overall_status, "unavailable");
  assert.equal(strengthUnavailableWithoutFailures.blocking, true);
  const recoveredReady = service.mergeReadyRankingsStatus({
    status: "strength_unavailable_recipes_cached",
    recipe_capabilities: { winning: { status: "unavailable" } },
    target_season_id: "s18",
    target_patch_id: "s18_1",
    target_core_profile_id: "a".repeat(64),
    candidate_stat_date: "20260820",
    update_available_for_next_match: true,
  }, { status: "ready", ok: true });
  assert.equal(recoveredReady.full_ranking_overlay_available, true);
  assert.equal(Object.hasOwn(recoveredReady, "recipe_capabilities"), false);
  assert.equal(Object.hasOwn(recoveredReady, "target_core_profile_id"), false);
  assert.equal(Object.hasOwn(recoveredReady, "candidate_stat_date"), false);
  assert.equal(Object.hasOwn(recoveredReady, "attempted_stat_date"), false);
  assert.equal(Object.hasOwn(recoveredReady, "update_available_for_next_match"), false);
  assert.equal(
    typeof service.rankingsStatusFromCurrentSnapshot,
    "function",
    "runtime service must expose current-snapshot status calculation for contract verification",
  );
  assert.equal(
    typeof service.reconcileActiveRankingStatus,
    "function",
    "Runtime must expose one shared Active Ranking reconciliation path for bootstrap and daemon startup",
  );
  assert.equal(typeof service.rankingsStatusAfterRuntimeRecovery, "function");
  const pendingRecovery = service.rankingsStatusAfterRuntimeRecovery({
    status: "semantic_maintenance_pending",
    candidate_generation_id: "candidate-next",
    pending_maintenance_input_hash: "maintenance-hash",
    retryable: true,
  }, {
    status: "ready",
    ranking_overlay_id: "active-current",
    snapshot_in_use: "active-current",
  });
  assert.equal(pendingRecovery.status, "semantic_maintenance_pending");
  assert.equal(pendingRecovery.active_snapshot_in_use, "active-current");
  assert.equal(pendingRecovery.active_snapshot.status, "ready");
  const completedRecovery = service.rankingsStatusAfterRuntimeRecovery({
    status: "semantic_maintenance_pending",
    candidate_generation_id: "active-current",
  }, {
    status: "ready",
    ranking_overlay_id: "active-current",
    snapshot_in_use: "active-current",
  });
  assert.equal(completedRecovery.status, "ready", "a pending status may clear only after its exact generation is active");
  assert.match(
    runtimeServiceSource,
    /async function stopMatch\(\)[\s\S]*?configureRuntimeServicePaths\(\{ dataRoot: runtimePaths\.runtimeDataRoot \}\)[\s\S]*?rankingsStatusAfterRuntimeRecovery/,
    "Stop Match must always rebind the lobby to the latest compatible Active closure",
  );
  assert.match(
    runtimeServiceSource,
    /async function bootstrap\(options = \{\}\)[\s\S]*?await reconcileActiveRankingStatus\(\)/,
    "full Runtime bootstrap must reuse the shared Active Ranking reconciliation path",
  );
  assert.match(
    await readFile(path.join(root, "ui/electron/runtime-daemon-server.js"), "utf8"),
    /await daemon\.reconcileDerivedStateOnStart\(\)/,
    "daemon startup must reconcile derived Ranking status before publishing readiness",
  );

  const currentSnapshotStatus = await service.rankingsStatusFromCurrentSnapshot();
  assert(
    ["ready", "ready_with_source_lag", "unavailable"].includes(currentSnapshotStatus.status),
    "rankings status must distinguish a compatible active overlay from an unavailable one",
  );
  assert.equal(currentSnapshotStatus.ok, ["ready", "ready_with_source_lag"].includes(currentSnapshotStatus.status));
  assert.equal(
    currentSnapshotStatus.full_ranking_overlay_available,
    currentSnapshotStatus.capability_status?.full_ranking_overlay_available === true,
    "the explicit full-overlay capability must be derived from per-domain capabilities",
  );
  assert.match(
    runtimeServiceSource,
    /status: capabilityStatus\.overall_status[\s\S]*?ok: \["ready", "ready_with_source_lag"\]\.includes\(capabilityStatus\.overall_status\)[\s\S]*?full_ranking_overlay_available: capabilityStatus\.full_ranking_overlay_available/,
    "the runtime status must derive readiness from per-domain capabilities",
  );
  assert.match(
    runtimeServiceSource,
    /async function persistRankingsStatus\(source, eventPayload = \{\}\)[\s\S]*?event_type: "rankings_status_changed"/,
    "all Ranking status transitions must use the single canonical status publisher",
  );
  assert.match(
    runtimeServiceSource,
    /maintenanceFinalized = true[\s\S]*?runNodeTool\("tools\/run-jcc-version-pipeline\.mjs", \[[\s\S]*?"prune"[\s\S]*?"--retain-previous", "2"[\s\S]*?generation_cleanup_status/,
    "Runtime 更新今日数据 must prune stale generations after successful publication without changing publication authority",
  );
  for (const source of [
    "ranking_recipes_cached_strength_unavailable",
    "rankings_candidate_update_completed",
    "ranking_publication_repair_required",
    "rankings_update_completed",
    "rankings_update_failed",
  ]) {
    assert.match(
      runtimeServiceSource,
      new RegExp(`persistRankingsStatus\\(\\\"${source}\\\"`),
      `${source} must publish a rankings_status_changed event`,
    );
  }
  assert.match(
    runtimeServiceSource,
    /const statDate = rankSignal\?\.stat_date \|\| manifest\?\.current\?\.stat_date \|\| null/,
    "the displayed Ranking date must come from the national strength-ranking snapshot",
  );
  assert.match(
    await readFile(path.join(root, "ui/src/App.tsx"), "utf8"),
    /const rankingStatDate = rankingStatusView\.active_stat_date/,
    "the status panel must use the canonical Ranking view projection rather than assemble dates itself",
  );
  const { buildRankingStatusViewModel } = await import("../ui/electron/ranking-status-view-model.js");
  const partialView = buildRankingStatusViewModel({ rankingsStatus: {
    status: "ready_partial", stat_date: "20260905", snapshot_in_use: "active-national",
    candidate_stat_date: "20260906", candidate_generation_id: "pending-recipe",
  }, updateTask: { status: "succeeded" } });
  assert.equal(partialView.active_stat_date, "20260905");
  assert.equal(partialView.active_recipe_id, null);
  if (currentSnapshotStatus.status === "unavailable") {
    assert.equal(currentSnapshotStatus.stat_date, null, "an incompatible prior-season overlay must not expose its date");
    assert.match(currentSnapshotStatus.snapshot_in_use, /^unavailable:[a-f0-9]{64}$/u);
  }
  assert.match(
    runtimeServiceSource,
    /if \(!identity\.ok\)[\s\S]*?status: "unavailable"[\s\S]*?stat_date: null[\s\S]*?snapshot_in_use: `unavailable:\$\{runtimePaths\.activeCoreProfileId \|\| "unknown-core"\}`/,
    "an incompatible active ranking generation must clear the foreign stat date instead of displaying stale data",
  );
  assert.match(
    runtimeServiceSource,
    /if \(!artifactIdentity\.ok\)[\s\S]*?ranking_overlay_id: null[\s\S]*?stat_date: null[\s\S]*?tiers: \{\}/,
    "Host ranking context must not expose a foreign overlay id or date when compatibility fails",
  );
  if (["ready", "ready_with_source_lag"].includes(currentSnapshotStatus.status)) {
    assert(currentSnapshotStatus.stat_date, "a compatible current rankings status must expose its stat date");
    const activeClosure = JSON.parse(await readFile(
      path.join(root, "data", "live-rankings", "jcc", "active-ranking-closure.json"),
      "utf8",
    ));
    assert.equal(
      currentSnapshotStatus.published_at,
      activeClosure.published_at,
      "current rankings status must preserve the Active closure publication time",
    );
    assert.equal(
      currentSnapshotStatus.last_successful_at,
      activeClosure.published_at,
      "last successful time must identify the currently active Ranking publication",
    );
    const staleStatusReconciled = await service.rankingsStatusFromCurrentSnapshot({
      status: "ready",
      stat_date: "20260811",
      generated_at: "2026-08-12T03:34:43.365Z",
      updated_at: "2026-08-12T03:34:43.734Z",
      completed_at: "2026-08-12T03:34:43.734Z",
    });
    assert.equal(
      staleStatusReconciled.updated_at,
      staleStatusReconciled.published_at || staleStatusReconciled.generated_at,
      "a newer current snapshot must not inherit an older snapshot's display timestamp",
    );
    const internallyStaleStatusReconciled = await service.rankingsStatusFromCurrentSnapshot({
      ...currentSnapshotStatus,
      updated_at: "2026-08-12T03:34:43.734Z",
      completed_at: "2026-08-12T03:34:43.734Z",
      last_successful_at: "2026-08-12T03:34:43.734Z",
      failed_at: "2026-08-10T15:02:39.484Z",
    });
    assert.equal(
      internallyStaleStatusReconciled.updated_at,
      internallyStaleStatusReconciled.published_at || internallyStaleStatusReconciled.generated_at,
      "status timestamp must never precede the current snapshot generation time",
    );
    assert.equal(internallyStaleStatusReconciled.completed_at, undefined);
    assert.equal(internallyStaleStatusReconciled.last_successful_at, currentSnapshotStatus.published_at);
    assert.equal(internallyStaleStatusReconciled.failed_at, undefined);
  }

  const canonicalRankingsState = {
    daily_session: { status: "active", generation: 1 },
    match_session: { status: "idle", match_session_id: null },
    response_task: { status: "idle", revision: 0 },
    response_task_revision: 0,
    rankings_status: { status: "ready", stat_date: "20260719" },
  };
  const rankingsMerge = daemon.mergeRuntimeServiceCanonicalSnapshot(
    canonicalRankingsState,
    {
      ...canonicalRankingsState,
      rankings_status: { status: "updating", stat_date: "20260719" },
    },
    { event_type: "rankings_status_changed" },
  );
  assert.equal(rankingsMerge.applied, true, "daemon must accept rankings status events as an owned global runtime field");
  assert.equal(rankingsMerge.state.rankings_status.status, "updating");
  assert(rankingsMerge.changed_keys.includes("rankings_status"));

  const taskOnlyUpdate = daemon.mergeRuntimeServiceCanonicalSnapshot(
    rankingsMerge.state,
    {
      ...rankingsMerge.state,
      ranking_update_task: { status: "succeeded", terminal: true },
      rankings_status: { status: "ready", ok: true, stat_date: "20260719", snapshot_in_use: "new-active" },
    },
    { event_type: "ranking_update_task_changed" },
  );
  assert.equal(taskOnlyUpdate.state.rankings_status.status, "updating", "task lifecycle events must not masquerade as Ranking status events");

  assert.equal(
    typeof daemon.preserveSqliteCanonicalState,
    "function",
    "daemon must expose bootstrap reconciliation for contract verification",
  );
  const reconciledBootstrap = daemon.preserveSqliteCanonicalState(
    {
      ...canonicalRankingsState,
      rankings_status: {
        status: "ready",
        stat_date: "20260813",
        generated_at: "2026-08-14T13:17:19.627Z",
        snapshot_in_use: "current",
      },
    },
    {
      ...canonicalRankingsState,
      rankings_status: {
        status: "ready",
        stat_date: "20260811",
        generated_at: "2026-08-12T03:34:43.365Z",
        snapshot_in_use: "current",
      },
    },
  );
  assert.equal(
    reconciledBootstrap.rankings_status.stat_date,
    "20260813",
    "bootstrap must prefer the audited current snapshot over stale SQLite display status",
  );

  const incompleteUpdate = await service.executeRankingsUpdate(async () => ({
    ok: true,
    schema: "jcc-live-rankings-update-result-v1",
    stat_date: "20260719",
    sync: { generated_at: "2026-07-20T05:26:55.171Z" },
    verification: { status: "pass" },
  }));
  assert.equal(incompleteUpdate.ok, false, "a tool success without a prepared generation must fail closed");
  assert.equal(incompleteUpdate.status, "rankings_update_failed");
  assert.match(incompleteUpdate.state.rankings_status.error, /did_not_prepare_semantic_maintenance_generation/);
  const activeDateBeforeCandidate = currentSnapshotStatus.stat_date;
  const activeSnapshotBeforeCandidate = currentSnapshotStatus.snapshot_in_use;

  const candidateSuccess = await service.executeRankingsUpdate(async () => ({
    ok: true,
    schema: "jcc-live-rankings-update-result-v1",
    stat_date: "20260821",
    sync: {
      ranking_target: {
        publication_scope: "candidate",
        season_id: "s18",
        patch_id: "s18_1",
        core_profile_id: "a".repeat(64),
      },
      candidate_generation: { generation_id: "20260821-candidate" },
    },
    verification: { status: "pass" },
  }));
  assert.equal(candidateSuccess.ok, true);
  assert.equal(candidateSuccess.status, "rankings_candidate_update_completed");
  assert.equal(candidateSuccess.state.rankings_status.status, "candidate_ready");
  assert.equal(candidateSuccess.state.rankings_status.candidate_stat_date, "20260821");
  assert.equal(candidateSuccess.state.rankings_status.stat_date, activeDateBeforeCandidate, "candidate refresh must preserve the active ranking date");
  assert.equal(candidateSuccess.state.rankings_status.snapshot_in_use, activeSnapshotBeforeCandidate);
  assert.equal(candidateSuccess.state.rankings_status.update_available_for_next_match, true);

  const recipesOnly = await service.executeRankingsUpdate(async () => ({
    ok: true,
    schema: "jcc-live-rankings-update-result-v1",
    status: "ranking_strength_unavailable_recipes_cached",
    stat_date: "20260822",
    sync: {
      status: "ranking_strength_unavailable_recipes_cached",
      ranking_target: {
        publication_scope: "active",
        season_id: "s18",
        patch_id: "s18_1",
        core_profile_id: "b".repeat(64),
      },
      recipe_capabilities: {
        popular: { status: "available", accepted_recipe_count: 13 },
        winning: { status: "available", accepted_recipe_count: 4 },
        combined: {
          status: "available",
          accepted_recipe_count: 17,
          generation_id: "c".repeat(64),
          source_capabilities: { winning: { status: "available", accepted_recipe_count: 4 } },
        },
      },
    },
    attempted_stat_date: "20260822",
    verification: { status: "skipped_strength_unavailable" },
  }));
  assert.equal(recipesOnly.ok, true, "recipe-only refresh must be a successful partial update");
  assert.equal(recipesOnly.status, "ranking_strength_unavailable_recipes_cached");
  assert.equal(recipesOnly.state.rankings_status.status, "strength_unavailable_recipes_cached");
  assert.equal(recipesOnly.state.rankings_status.ok, false, "recipes must not make the strength overlay ready");
  assert.equal(recipesOnly.state.rankings_status.full_ranking_overlay_available, false);
  assert.equal(recipesOnly.state.rankings_status.recipe_capabilities.popular.accepted_recipe_count, 13);
  assert.equal(recipesOnly.state.rankings_status.recipe_capabilities.combined.accepted_recipe_count, 13);
  assert.equal(recipesOnly.state.rankings_status.recipe_capabilities.winning.status, "unavailable_master_plus_audit_failed");
  assert.equal(recipesOnly.state.rankings_status.recipe_capabilities.winning.accepted_recipe_count, 0);
  assert.equal(recipesOnly.state.rankings_status.attempted_stat_date, "20260822");
  assert.equal(recipesOnly.state.rankings_status.stat_date, activeDateBeforeCandidate, "recipe-only refresh must preserve the active strength date");
  assert.equal(recipesOnly.state.rankings_status.snapshot_in_use, activeSnapshotBeforeCandidate, "recipe-only refresh must preserve the active strength pointer");

  const failed = await service.executeRankingsUpdate(async () => {
    throw new Error(`upstream failed at ${root}\\private-token.txt`);
  });
  assert.equal(failed.ok, false, "tool failure must not be wrapped as ok:true");
  assert.equal(failed.status, "rankings_update_failed");
  assert.equal(failed.state.rankings_status.status, "failed");
  assert(failed.state.rankings_status.error, "failed update must preserve a user-displayable diagnostic");
  assert(!failed.state.rankings_status.error.includes(root), "rankings diagnostics must redact repository paths");
  assert.equal(failed.state.rankings_status.stat_date, currentSnapshotStatus.stat_date, "failed refresh must preserve the audited active ranking date");

  console.log(JSON.stringify({
    ok: true,
    schema: "jcc-rankings-status-runtime-contract-v1",
    checked: [
      currentSnapshotStatus.status === "ready"
        ? "compatible_successful_update_persists_canonical_rankings_status"
        : "tool_success_without_compatible_overlay_fails_closed",
      "candidate_update_does_not_activate_or_replace_current_rankings",
      "popular_recipes_cache_without_claiming_master_plus_strength",
      "full_overlay_capability_is_explicit_in_ready_and_unavailable_states",
      "partial_metadata_is_removed_when_full_overlay_recovers",
      "status_panel_uses_complete_current_snapshot_identity",
      "incompatible_active_rankings_clear_foreign_stat_date",
      "incompatible_host_context_clears_overlay_identity_and_caches",
      ...(currentSnapshotStatus.status === "ready" ? ["status_panel_replaces_stale_snapshot_timestamp"] : []),
      "daemon_merges_rankings_status_event_into_canonical_state",
      "bootstrap_reconciles_rankings_status_from_audited_current_snapshot",
      "failed_update_returns_ok_false",
      "failed_update_preserves_last_good_snapshot",
      "failed_update_diagnostic_redacts_paths",
    ],
  }, null, 2));
} finally {
  await service.handleRuntimeAction("shutdown", { reason: "rankings_status_contract_cleanup" }, null).catch(() => {});
  service.configureRuntimeServicePaths({ dataRoot: originalRuntimeDataRoot });
  await rm(tempRoot, { recursive: true, force: true });
}
