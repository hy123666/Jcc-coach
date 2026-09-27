import { randomUUID } from "node:crypto";
export {
  rankingUpdateTaskMatchesActiveSnapshot,
  reconcileRankingUpdateTaskWithActiveSnapshot,
} from "./ranking-task-snapshot-identity.js";

export const RANKING_UPDATE_TASK_SCHEMA = "jcc-ranking-update-task-v1";

const ACTIVE_STATUSES = new Set(["queued", "running"]);
const RETRYABLE_STATUSES = new Set(["retryable"]);
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "retryable"]);

export function createRankingUpdateTask({ taskId = randomUUID(), now = new Date().toISOString() } = {}) {
  return {
    schema: RANKING_UPDATE_TASK_SCHEMA,
    task_id: String(taskId),
    status: "queued",
    terminal: false,
    progress: { phase: "queued", completed_steps: 0, total_steps: 5 },
    created_at: now,
    queued_at: now,
    started_at: null,
    completed_at: null,
    failed_at: null,
    error: null,
    result_status: null,
    candidate_stat_date: null,
    candidate_generation_id: null,
    published_stat_date: null,
    published_snapshot_id: null,
    published_at: null,
  };
}

export function rankingUpdateTaskIsActive(task) {
  return ACTIVE_STATUSES.has(String(task?.status || "")) && task?.terminal !== true;
}

export function rankingUpdateTaskIsTerminal(task) {
  return task?.terminal === true || TERMINAL_STATUSES.has(String(task?.status || ""));
}

export function transitionRankingUpdateTask(task, nextStatus, patch = {}, now = new Date().toISOString()) {
  const current = task && typeof task === "object" ? task : createRankingUpdateTask({ now });
  const status = String(nextStatus || "");
  if (![...ACTIVE_STATUSES, ...RETRYABLE_STATUSES, ...TERMINAL_STATUSES].includes(status)) {
    throw new Error(`invalid ranking update task status: ${status}`);
  }
  if (rankingUpdateTaskIsTerminal(current) && status !== current.status) {
    throw new Error("ranking update task is already terminal");
  }
  const next = {
    ...current,
    ...patch,
    schema: RANKING_UPDATE_TASK_SCHEMA,
    task_id: String(current.task_id || patch.task_id || ""),
    status,
    terminal: TERMINAL_STATUSES.has(status),
  };
  if (status === "running" && !next.started_at) next.started_at = now;
  if (status === "succeeded") {
    next.completed_at = next.completed_at || now;
    next.failed_at = null;
    next.error = null;
  }
  if (status === "failed") {
    next.failed_at = next.failed_at || now;
    next.completed_at = null;
    next.error = String(next.error || "ranking_update_failed");
  }
  return next;
}

export function reconcileInterruptedRankingUpdateTask(task, { runtimeInstanceId = null, now = new Date().toISOString() } = {}) {
  if (!rankingUpdateTaskIsActive(task)) return task || null;
  if (runtimeInstanceId && task.owner_instance_id === runtimeInstanceId) return task;
  return transitionRankingUpdateTask(task, "failed", {
    error: "ranking_update_interrupted_by_runtime_restart",
    failure_reason: "runtime_restart_or_process_recovery",
  }, now);
}
