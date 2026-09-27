import assert from "node:assert/strict";
import {
  createRankingUpdateTask,
  rankingUpdateTaskIsActive,
  rankingUpdateTaskIsTerminal,
  rankingUpdateTaskMatchesActiveSnapshot,
  reconcileRankingUpdateTaskWithActiveSnapshot,
  reconcileInterruptedRankingUpdateTask,
  transitionRankingUpdateTask,
} from "../ui/electron/ranking-update-task.js";
import { readFile } from "node:fs/promises";

const now = "2026-09-02T04:00:00.000Z";
const queued = createRankingUpdateTask({ taskId: "ranking-task-test", now });
assert.equal(queued.status, "queued");
assert.equal(queued.terminal, false);
assert.equal(rankingUpdateTaskIsActive(queued), true);
assert.equal(rankingUpdateTaskIsTerminal(queued), false);

const running = transitionRankingUpdateTask(queued, "running", {}, now);
assert.equal(running.started_at, now);
assert.equal(rankingUpdateTaskIsActive(running), true);

const retryable = transitionRankingUpdateTask(running, "retryable", {
  result_status: "semantic_maintenance_pending",
}, now);
assert.equal(retryable.terminal, true);
assert.equal(rankingUpdateTaskIsTerminal(retryable), true);
assert.equal(rankingUpdateTaskIsActive(retryable), false);

const restarted = reconcileInterruptedRankingUpdateTask(running, { now });
assert.equal(restarted.status, "failed");
assert.equal(restarted.error, "ranking_update_interrupted_by_runtime_restart");
assert.equal(restarted.terminal, true);

const succeeded = transitionRankingUpdateTask(running, "succeeded", {
  result_status: "rankings_update_completed",
}, now);
assert.equal(succeeded.error, null);
assert.equal(succeeded.terminal, true);
assert.equal(succeeded.published_snapshot_id, null);
assert.throws(() => transitionRankingUpdateTask(succeeded, "failed", {}, now), /already terminal/);

const activeStatus = {
  snapshot_in_use: "ranking-active",
  ranking_overlay_identity: { ranking_stat_date: "20260912" },
};
assert.equal(
  rankingUpdateTaskMatchesActiveSnapshot({
    ...succeeded,
    published_snapshot_id: "ranking-active",
    published_stat_date: "20260912",
  }, activeStatus),
  true,
  "a successful task must identify the Active snapshot it published",
);
assert.equal(
  rankingUpdateTaskMatchesActiveSnapshot(succeeded, activeStatus),
  false,
  "legacy successful tasks without publication identity must not represent current Active data",
);
assert.equal(
  reconcileRankingUpdateTaskWithActiveSnapshot(succeeded, activeStatus),
  null,
  "a legacy successful task must be retired when Active snapshot identity is known",
);

const service = await readFile(new URL("../ui/electron/runtime-service.js", import.meta.url), "utf8");
const daemon = await readFile(new URL("../ui/electron/runtime-daemon.js", import.meta.url), "utf8");
const app = await readFile(new URL("../ui/src/App.tsx", import.meta.url), "utf8");
assert.match(service, /async function startRankingsUpdateTask\(\)/);
assert.match(service, /status: "ranking_update_started"/);
assert.match(service, /ranking_update_task_interrupted_on_runtime_restart/);
assert.match(daemon, /eventType === "ranking_update_task_changed"/);
assert.match(app, /const task = runtimeState\?\.ranking_update_task;[\s\S]*?if \(!task\?\.task_id \|\| !task\.terminal\)/);
assert.match(app, /rankingUpdateStartedTaskIdRef\.current !== task\.task_id/);
assert.match(app, /rankingUpdateStartedTaskIdRef\.current = result\.task_id/);
assert.match(app, /今日数据更新任务已启动/);
assert.doesNotMatch(app, /result\.ok\s*\?\s*"掌盟大师以上今日数据更新完成/);

console.log(JSON.stringify({
  schema: "jcc-ranking-update-task-lifecycle-verification-v1",
  status: "pass",
  checked: [
    "queued_running_terminal_transitions",
    "retryable_terminal_state",
    "runtime_restart_reconciliation",
    "terminal_transition_guard",
    "background_start_contract",
    "daemon_task_state_merge",
    "renderer_terminal_only_completion",
  ],
}, null, 2));
