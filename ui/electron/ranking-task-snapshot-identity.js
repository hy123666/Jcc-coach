export function rankingUpdateTaskMatchesActiveSnapshot(task, activeStatus) {
  if (String(task?.status || "") !== "succeeded") return true;
  const activeSnapshotId = String(
    activeStatus?.snapshot_in_use
      || activeStatus?.ranking_overlay_id
      || activeStatus?.ranking_overlay_identity?.ranking_overlay_id
      || "",
  ).trim();
  const taskSnapshotId = String(
    task?.published_snapshot_id
      || task?.ranking_overlay_id
      || "",
  ).trim();
  const activeStatDate = String(
    activeStatus?.ranking_overlay_identity?.ranking_stat_date
      || activeStatus?.stat_date
      || "",
  ).trim();
  const taskStatDate = String(task?.published_stat_date || "").trim();
  return Boolean(
    activeSnapshotId
      && taskSnapshotId
      && activeSnapshotId === taskSnapshotId
      && (!activeStatDate || !taskStatDate || activeStatDate === taskStatDate),
  );
}

export function reconcileRankingUpdateTaskWithActiveSnapshot(task, activeStatus) {
  if (!task || typeof task !== "object") return null;
  if (String(task.status || "") === "succeeded" && !rankingUpdateTaskMatchesActiveSnapshot(task, activeStatus)) {
    return null;
  }
  return task;
}
