import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createRuntimeSqliteStore,
  RUNTIME_LOG_CONTEXT_MAX_BYTES,
  RUNTIME_LOG_MESSAGE_MAX_BYTES,
  RUNTIME_QUEUE_ERROR_MAX_BYTES,
  RUNTIME_QUEUE_PAYLOAD_MAX_BYTES,
} from "../ui/electron/runtime-state-store.js";
import {
  compactAdviceTaskLifecycle,
  compactPersistedResponseTask,
} from "../ui/electron/runtime-daemon.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-runtime-db-budget-"));
  const store = createRuntimeSqliteStore(process.cwd(), { dataRoot: tempRoot }).open();
  try {
    for (let index = 0; index < 25; index += 1) {
      store.appendEvent("test.event", { index });
      store.appendLog("info", `log-${index}`, { index });
      const item = store.enqueue("test_queue", { index });
      const claimed = store.claimQueueItemById(item.id, { workerId: "budget-test" });
      store.completeQueueItem(item.id, {}, {
        workerId: claimed.locked_by,
        leaseToken: claimed.lease_token,
        leaseGeneration: claimed.lease_generation,
      });
    }
    for (let index = 0; index < 25; index += 1) {
      store.enqueue("advice_task_lifecycle", { index, expired_tasks: [{ payload: "x".repeat(4096) }] }, "observed");
    }
    const liveQueue = store.enqueue("runtime_action_task", { must_survive: true }, "pending");
    const result = store.enforceRetentionBudget({
      keepEvents: 7,
      keepLogs: 5,
      keepTerminalQueuePerName: 6,
      keepTerminalQueueTotal: 7,
      queueOverrides: { advice_task_lifecycle: 2 },
    });
    const eventCount = store.db.prepare("SELECT COUNT(*) AS count FROM runtime_events").get().count;
    const logCount = store.db.prepare("SELECT COUNT(*) AS count FROM runtime_logs").get().count;
    const queueCount = store.db.prepare("SELECT COUNT(*) AS count FROM runtime_queue WHERE status = 'completed'").get().count;
    const lifecycleCount = store.db.prepare("SELECT COUNT(*) AS count FROM runtime_queue WHERE queue_name = 'advice_task_lifecycle'").get().count;
    const terminalQueueCount = store.db.prepare("SELECT COUNT(*) AS count FROM runtime_queue WHERE status IN ('completed', 'observed', 'failed', 'cancelled', 'superseded')").get().count;
    assert(result.canonical_store === "app.sqlite", "budget result must identify SQLite as canonical store");
    assert(eventCount <= 7, `event count should be bounded, got ${eventCount}`);
    assert(logCount <= 5, `log count should be bounded, got ${logCount}`);
    assert(queueCount <= 6, `completed queue count should be bounded, got ${queueCount}`);
    assert(lifecycleCount <= 2, `observed lifecycle queue should be bounded, got ${lifecycleCount}`);
    assert(terminalQueueCount <= 7, `terminal queue should obey the global bound, got ${terminalQueueCount}`);
    assert(store.listQueue({ queueName: "runtime_action_task", status: "pending", limit: 10 }).some((row) => row.id === liveQueue.id), "live pending work must survive retention");

    const queueCountBeforeOversizedInsert = store.db.prepare("SELECT COUNT(*) AS count FROM runtime_queue").get().count;
    const oversizedQueueText = "队列负载".repeat(Math.ceil(RUNTIME_QUEUE_PAYLOAD_MAX_BYTES / 3));
    assert(Buffer.byteLength(JSON.stringify({ text: oversizedQueueText }), "utf8") > RUNTIME_QUEUE_PAYLOAD_MAX_BYTES, "queue fixture must exceed the UTF-8 row limit");
    let oversizedQueueRejected = false;
    try {
      store.enqueue("oversized_queue", { text: oversizedQueueText });
    } catch (error) {
      oversizedQueueRejected = error instanceof RangeError && /UTF-8 limit/.test(error.message);
    }
    assert(oversizedQueueRejected, "enqueue must reject an oversized serialized UTF-8 payload before insert");
    assert(store.db.prepare("SELECT COUNT(*) AS count FROM runtime_queue").get().count === queueCountBeforeOversizedInsert, "rejected queue payload must not create a row");

    const failingQueue = store.enqueue("oversized_error_queue", { bounded: true });
    const claimedFailingQueue = store.claimQueueItemById(failingQueue.id, { workerId: "oversized-error-worker" });
    const retriedQueue = store.failQueueItem(failingQueue.id, {
      code: "OVERSIZED_MULTIBYTE_ERROR",
      message: "队列失败详情".repeat(Math.ceil(RUNTIME_QUEUE_ERROR_MAX_BYTES / 3)),
    }, {
      workerId: claimedFailingQueue.locked_by,
      leaseToken: claimedFailingQueue.lease_token,
      leaseGeneration: claimedFailingQueue.lease_generation,
    });
    const boundedQueueErrorRow = store.db.prepare(`
      SELECT status,
             length(CAST(error_json AS BLOB)) AS error_bytes,
             error_json
      FROM runtime_queue
      WHERE id = ?
    `).get(failingQueue.id);
    assert(retriedQueue?.status === "retry", "oversized queue failure must release the lease into retry state");
    assert(boundedQueueErrorRow.error_bytes <= RUNTIME_QUEUE_ERROR_MAX_BYTES, `queue error must be UTF-8 bounded, got ${boundedQueueErrorRow.error_bytes}`);
    const boundedQueueError = JSON.parse(boundedQueueErrorRow.error_json);
    assert(boundedQueueError.error_truncated === true, "oversized queue error must persist a bounded truncation audit");
    assert(boundedQueueError.original_error_bytes > RUNTIME_QUEUE_ERROR_MAX_BYTES, "queue error audit must retain the original UTF-8 byte count");
    assert(typeof boundedQueueError.original_error_hash === "string" && boundedQueueError.original_error_hash.length === 64, "queue error audit must retain a SHA-256 identity");

    const retiringMatchId = "match-oversized-retirement-reason";
    const retiringQueue = store.enqueue("match_retirement_queue", { match_session_id: retiringMatchId }, "pending", {
      scopeType: "match",
      scopeSessionId: retiringMatchId,
    });
    const oversizedRetirementReason = "对局结束原因🙂".repeat(Math.ceil(RUNTIME_QUEUE_ERROR_MAX_BYTES / 3));
    const settledMatchQueue = store.settleMatchQueueItems(retiringMatchId, { reason: oversizedRetirementReason });
    assert(settledMatchQueue.includes(retiringQueue.id), "match retirement must settle the matching queue row");
    const settledMatchQueueRow = store.db.prepare(`
      SELECT status, locked_by, locked_at, lease_token,
             length(CAST(error_json AS BLOB)) AS error_bytes,
             error_json
      FROM runtime_queue
      WHERE id = ?
    `).get(retiringQueue.id);
    assert(settledMatchQueueRow.status === "cancelled", "match retirement must make the queue row terminal");
    assert(settledMatchQueueRow.locked_by === null && settledMatchQueueRow.locked_at === null && settledMatchQueueRow.lease_token === null, "match retirement must clear queue lease fields");
    assert(settledMatchQueueRow.error_bytes <= RUNTIME_QUEUE_ERROR_MAX_BYTES, `match retirement error must be UTF-8 bounded, got ${settledMatchQueueRow.error_bytes}`);
    const settledMatchQueueError = JSON.parse(settledMatchQueueRow.error_json);
    assert(settledMatchQueueError.error_truncated === true, "oversized match retirement reason must persist a bounded truncation audit");
    assert(settledMatchQueueError.original_error_bytes > RUNTIME_QUEUE_ERROR_MAX_BYTES, "match retirement audit must retain the original UTF-8 byte count");
    assert(typeof settledMatchQueueError.original_error_hash === "string" && settledMatchQueueError.original_error_hash.length === 64, "match retirement audit must retain a SHA-256 identity");
    assert(!String(settledMatchQueueError.message || "").includes("�"), "match retirement error summary must preserve Unicode code-point boundaries");

    const oversizedLog = store.appendLog(
      "warn",
      "中文日志".repeat(Math.ceil(RUNTIME_LOG_MESSAGE_MAX_BYTES / 3)),
      { context: "诊断上下文".repeat(Math.ceil(RUNTIME_LOG_CONTEXT_MAX_BYTES / 3)) },
    );
    const boundedLogRow = store.db.prepare(`
      SELECT length(CAST(message AS BLOB)) AS message_bytes,
             length(CAST(payload_json AS BLOB)) AS context_bytes,
             payload_json
      FROM runtime_logs
      WHERE id = ?
    `).get(oversizedLog.id);
    assert(boundedLogRow.message_bytes <= RUNTIME_LOG_MESSAGE_MAX_BYTES, `log message must be UTF-8 bounded, got ${boundedLogRow.message_bytes}`);
    assert(boundedLogRow.context_bytes <= RUNTIME_LOG_CONTEXT_MAX_BYTES, `log context must be UTF-8 bounded, got ${boundedLogRow.context_bytes}`);
    assert(JSON.parse(boundedLogRow.payload_json).context_truncated === true, "oversized log context must persist a bounded truncation audit");
    const emojiLog = store.appendLog("info", "🙂".repeat(RUNTIME_LOG_MESSAGE_MAX_BYTES), {});
    assert(!emojiLog.message.includes("�"), "UTF-8 log truncation must preserve Unicode code-point boundaries");
    assert(Buffer.byteLength(emojiLog.message, "utf8") <= RUNTIME_LOG_MESSAGE_MAX_BYTES, "emoji log message must remain inside the UTF-8 row limit");

    for (let index = 0; index < 10; index += 1) {
      store.appendEvent("multibyte-budget", { index, text: "汉字诊断".repeat(80) });
    }
    store.enforceRetentionBudget({
      keepEvents: 1000,
      keepEventBytes: 2048,
      keepLogs: 5,
      keepTerminalQueuePerName: 6,
      keepTerminalQueueTotal: 7,
      queueOverrides: { advice_task_lifecycle: 2 },
    });
    const retainedEventBlobBytes = store.db.prepare("SELECT COALESCE(SUM(length(CAST(payload_json AS BLOB))), 0) AS bytes FROM runtime_events").get().bytes;
    assert(retainedEventBlobBytes <= 2048, `event byte budget must use serialized UTF-8 bytes, got ${retainedEventBlobBytes}`);

    for (let index = 0; index < 12; index += 1) {
      store.appendLog("info", `日志-${index}-${"界".repeat(180)}`, { index, text: "文".repeat(180) });
      store.enqueue("byte_budget_queue", { index, text: "列".repeat(300) }, "completed");
    }
    store.enforceRetentionBudget({
      keepEvents: 1000,
      keepEventBytes: 2048,
      keepLogs: 1000,
      keepLogBytes: 2500,
      keepTerminalQueuePerName: 1000,
      keepTerminalQueueTotal: 1000,
      keepTerminalQueueBytes: 2500,
      queueOverrides: {},
    });
    const retainedLogBytes = store.db.prepare(`
      SELECT COALESCE(SUM(length(CAST(message AS BLOB)) + length(CAST(payload_json AS BLOB))), 0) AS bytes
      FROM runtime_logs
    `).get().bytes;
    const retainedTerminalQueueBytes = store.db.prepare(`
      SELECT COALESCE(SUM(length(CAST(payload_json AS BLOB)) + length(CAST(COALESCE(error_json, '') AS BLOB))), 0) AS bytes
      FROM runtime_queue
      WHERE status IN ('completed', 'observed', 'failed', 'cancelled', 'superseded')
    `).get().bytes;
    assert(retainedLogBytes <= 2500, `log retention must use serialized UTF-8 bytes, got ${retainedLogBytes}`);
    assert(retainedTerminalQueueBytes <= 2500, `terminal queue retention must use serialized UTF-8 bytes, got ${retainedTerminalQueueBytes}`);
    assert(store.getQueueItem(liveQueue.id)?.status === "pending", "UTF-8 byte retention must never delete active queue work");

    const lifecycle = compactAdviceTaskLifecycle({
      match_session_id: "match-1",
      active_tasks: [{ task_id: "task-1", trigger_id: "tempo", status: "running", payload: "x".repeat(200000) }],
      expired_tasks: Array.from({ length: 50 }, (_, index) => ({ task_id: `expired-${index}`, status: "expired", payload: "x".repeat(2000) })),
      output_history: Array.from({ length: 50 }, (_, index) => ({ task_id: `output-${index}`, status: "completed", payload: "x".repeat(2000) })),
      previous_advice_state: { payload: "x".repeat(200000) },
    });
    assert(JSON.stringify(lifecycle).length < 16000, "durable lifecycle diagnostics must be a compact summary");
    assert(lifecycle.original_payload_bytes > 400000, "lifecycle summary must retain original size evidence");

    const compactTask = compactPersistedResponseTask({
      response_task_id: "response-1",
      revision: 7,
      status: "running",
      match_session_id: "match-1",
      host_request: {
        request_id: "request-1",
        request_hash: "hash-1",
        mode: "cruise",
        created_at: "2026-08-15T00:00:00.000Z",
        runtime_context: { match_session: { match_session_id: "match-1" }, huge: "x".repeat(5_000_000) },
        context: { daily_big_data: "x".repeat(5_000_000) },
      },
    });
    assert(compactTask.response_task_id === "response-1" && compactTask.revision === 7 && compactTask.status === "running", "response task identity must survive compaction");
    assert(compactTask.host_request.request_id === "request-1", "host request identity must survive compaction");
    assert(JSON.stringify(compactTask).length < 32000, "canonical response task must not persist the multi-megabyte selected context");

    const leaseDir = path.join(tempRoot, "runtime-daemon");
    await mkdir(leaseDir, { recursive: true });
    await writeFile(path.join(leaseDir, "writer-lease.json"), `${JSON.stringify({
      schema: "jcc-runtime-writer-lease-v1",
      pid: process.pid,
      sqlite_file: store.paths.sqliteFile,
    })}\n`, "utf8");
    const guardedMaintenance = spawnSync(process.execPath, ["tools/maintain-jcc-runtime-db.mjs", "--vacuum"], {
      cwd: process.cwd(),
      env: { ...process.env, JCC_RUNTIME_DATA_DIR: tempRoot },
      encoding: "utf8",
      timeout: 15000,
    });
    assert(guardedMaintenance.status !== 0, "offline maintenance must refuse to open SQLite while the daemon writer is active");
    assert(/writer PID .* is active/.test(guardedMaintenance.stderr), "offline maintenance refusal must identify the active writer lease");
  } finally {
    store.close();
    await rm(tempRoot, { recursive: true, force: true });
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    checked: [
      "runtime-events-retention",
      "utf8-event-byte-budget",
      "utf8-queue-row-hard-limit",
      "utf8-queue-error-row-hard-limit",
      "utf8-match-retirement-error-row-hard-limit",
      "utf8-log-row-hard-limits",
      "utf8-log-global-byte-budget",
      "utf8-terminal-queue-global-byte-budget",
      "runtime-logs-retention",
      "completed-queue-retention",
      "active-queue-retention-protection",
      "sqlite-budget-enforcement",
      "active-writer-maintenance-guard",
    ],
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
