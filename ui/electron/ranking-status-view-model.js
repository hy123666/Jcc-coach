import { rankingUpdateTaskMatchesActiveSnapshot } from "./ranking-task-snapshot-identity.js";

export function buildRankingStatusViewModel({ rankingsStatus = null, updateTask = null } = {}) {
  const outer = rankingsStatus && typeof rankingsStatus === "object" ? rankingsStatus : {};
  const status = outer.active_snapshot && typeof outer.active_snapshot === "object"
    ? outer.active_snapshot : outer;
  const task = updateTask && typeof updateTask === "object" ? updateTask : {};
  const overlay = status.ranking_overlay_identity || {};
  const snapshotId = status.snapshot_in_use || overlay.ranking_overlay_id || null;
  const unavailable = typeof snapshotId === "string" && snapshotId.startsWith("unavailable:");
  const hasActiveSnapshot = Boolean(snapshotId && !unavailable);
  const taskStatus = task.status || null;
  const taskMatchesActive = taskStatus !== "succeeded"
    || rankingUpdateTaskMatchesActiveSnapshot(task, status);
  return Object.freeze({
    schema: "jcc-ranking-status-view-v1",
    active_stat_date: hasActiveSnapshot ? overlay.ranking_stat_date || status.stat_date || null : null,
    active_snapshot_id: hasActiveSnapshot ? snapshotId : null,
    active_core_id: overlay.core_profile_id || null,
    active_recipe_id: hasActiveSnapshot ? status.active_recipe_id || null : null,
    source_freshness: status.source_freshness || status.evidence_domains || null,
    active_status: status.capability_status?.overall_status || (hasActiveSnapshot ? "available" : "unavailable"),
    update_task_status: taskMatchesActive ? taskStatus : null,
    update_task_phase: taskMatchesActive ? task.progress?.phase || null : null,
    update_task_busy: taskStatus === "queued" || taskStatus === "running",
    last_success_at: hasActiveSnapshot
      ? status.last_successful_at || status.published_at || status.generated_at || null
      : null,
    error: taskStatus === "failed" ? task.error || status.error || null : null,
    active_error: hasActiveSnapshot ? null : status.error || null,
  });
}
