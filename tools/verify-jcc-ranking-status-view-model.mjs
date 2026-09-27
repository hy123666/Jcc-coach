import assert from "node:assert/strict";
import { buildRankingStatusViewModel } from "../ui/electron/ranking-status-view-model.js";

const active = {
  stat_date: "20260904", snapshot_in_use: "ranking-active", active_recipe_id: "recipe-active",
  ranking_overlay_identity: { ranking_stat_date: "20260905", core_profile_id: "core-active" },
  candidate_generation_id: "candidate-unpublished", candidate_stat_date: "20260906",
  last_successful_at: "2026-09-05T10:00:00Z", updated_at: "2026-09-06T10:00:00Z",
};
for (const status of ["queued", "running", "succeeded", "failed"]) {
  const view = buildRankingStatusViewModel({ rankingsStatus: active, updateTask: {
    status, progress: { phase: "semantic_maintenance" }, error: "update-error",
  } });
  assert.equal(view.active_stat_date, "20260905");
  assert.equal(view.active_snapshot_id, "ranking-active");
  assert.equal(view.active_recipe_id, "recipe-active");
  assert.equal(view.last_success_at, "2026-09-05T10:00:00Z");
  assert.equal(view.error, status === "failed" ? "update-error" : null);
  assert.equal(view.update_task_busy, ["queued", "running"].includes(status));
}
const unavailable = buildRankingStatusViewModel({ rankingsStatus: {
  ...active, snapshot_in_use: "unavailable:core", error: "missing-active",
}, updateTask: { status: "succeeded" } });
assert.equal(unavailable.active_stat_date, null);
assert.equal(unavailable.active_recipe_id, null);
assert.equal(unavailable.active_error, "missing-active");
assert.equal(buildRankingStatusViewModel().active_status, "unavailable");
const { rankingsStatusAfterRuntimeRecovery, mergeReadyRankingsStatus } = await import("../ui/electron/runtime-service.js");
const recovered = rankingsStatusAfterRuntimeRecovery({
  ...active, status: "semantic_maintenance_pending", candidate_generation_id: "pending-new",
}, { status: "unavailable", snapshot_in_use: "unavailable:core-C", error: "incompatible", ranking_overlay_identity: { core_profile_id: "core-C" } });
const recoveryView = buildRankingStatusViewModel({ rankingsStatus: recovered });
assert.equal(recoveryView.active_snapshot_id, null);
assert.equal(recoveryView.active_core_id, "core-C");
assert.equal(recoveryView.active_recipe_id, null);
assert.equal(recoveryView.active_stat_date, null);
assert.equal(recoveryView.active_error, "incompatible");
const next = {
  status: "ready", ok: true, snapshot_in_use: "ranking-next", active_recipe_id: "recipe-next",
  ranking_overlay_identity: { ranking_stat_date: "20260906", core_profile_id: "core-next" },
  last_successful_at: "2026-09-06T12:00:00Z", error: null,
};
for (const pendingStatus of ["semantic_maintenance_pending", "publication_committed_needs_repair"]) {
  for (const current of [active, recovered.active_snapshot]) {
    const pending = rankingsStatusAfterRuntimeRecovery({
      ...active, status: pendingStatus, candidate_generation_id: "pending-next",
    }, current);
    const ready = mergeReadyRankingsStatus(pending, next);
    const readyView = buildRankingStatusViewModel({ rankingsStatus: ready, updateTask: { status: "succeeded" } });
    assert.equal(readyView.active_snapshot_id, "ranking-next");
    assert.equal(readyView.active_core_id, "core-next");
    assert.equal(readyView.active_recipe_id, "recipe-next");
    assert.equal(readyView.active_stat_date, "20260906");
    assert.equal(readyView.last_success_at, next.last_successful_at);
    assert.equal(readyView.active_error, null);
    for (const key of ["active_snapshot", "active_snapshot_in_use", "active_snapshot_unchanged"]) {
      assert.equal(Object.hasOwn(ready, key), false, `successful refresh must retire ${key}`);
    }
  }
}

const publishedOnly = {
  status: "ready", ok: true, snapshot_in_use: "ranking-published",
  ranking_overlay_identity: { ranking_stat_date: "20260912" },
  generated_at: "2026-09-13T12:53:45.769Z",
  published_at: "2026-09-14T07:46:28.403Z",
};
const staleSucceeded = buildRankingStatusViewModel({
  rankingsStatus: publishedOnly,
  updateTask: { status: "succeeded", result_status: "rankings_update_completed" },
});
assert.equal(staleSucceeded.update_task_status, null, "an unbound legacy success must not be shown for the current snapshot");
assert.equal(staleSucceeded.last_success_at, publishedOnly.published_at, "the panel must display Active publication time");
const currentSucceeded = buildRankingStatusViewModel({
  rankingsStatus: publishedOnly,
  updateTask: {
    status: "succeeded", result_status: "rankings_update_completed",
    published_snapshot_id: "ranking-published", published_stat_date: "20260912",
  },
});
assert.equal(currentSucceeded.update_task_status, "succeeded", "a successful task bound to Active must remain visible");
console.log(JSON.stringify({ ok: true, checked: ["active-date-authority", "candidate-not-active", "last-success-not-attempt", "unavailable-after-success", "task-progress-independent", "recovery_then_success_retires_old_snapshot"] }));
