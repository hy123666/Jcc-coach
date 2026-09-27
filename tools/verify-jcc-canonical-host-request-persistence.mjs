import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JccRuntimeDaemon } from "../ui/electron/runtime-daemon.js";
import { JccRuntimeSqliteStore } from "../ui/electron/runtime-state-store.js";

const sentinel = "JCC_VISUAL_FULL_REQUEST_MUST_NOT_REACH_SQLITE_58d4e90a";
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-canonical-host-request-"));
let store = null;

try {
  store = new JccRuntimeSqliteStore({ sqliteFile: path.join(tempRoot, "app.sqlite") }).open();
  const responseTask = {
    schema: "jcc-runtime-response-task-v1",
    response_task_id: "visual-task-1",
    revision: 0,
    status: "awaiting_host_cli_agent_response",
    mode: "augment_choice",
  };
  store.commitRuntimeTransition({
    state: {
      schema: "jcc-ui-runtime-state-v1",
      response_task_revision: 0,
      response_task: responseTask,
      visual_request_status: {
        status: "running_host_cli_visual",
        request_id: "visual-request-1",
        host_request: {
          request_id: "visual-request-1",
          request_hash: "visual-request-hash-1",
          mode: "augment_choice",
          request_kind: "hard_data_query",
          origin_action_id: "cruise_no_big_data",
          evidence_policy_id: "active_core_profile_only",
          selected_ranking_candidates: {
            complete_strategy_package: `${sentinel}${"r".repeat(300_000)}`,
          },
          strategy_context: { sentinel },
          runtime_context: {
            match_session: { match_session_id: "match-1" },
            decision_snapshot: {
              stage_round: "4-2",
              snapshot_fingerprint: "snapshot-1",
              current_turn_sentinel: sentinel,
            },
          },
        },
      },
    },
    responseTask,
    eventType: "verify_visual_request_storage_sanitization",
  });

  const persistedState = store.getJson("ui_runtime_state");
  const persistedRequest = persistedState.visual_request_status.host_request;
  assert.equal(persistedRequest.schema, "jcc-host-request-ref-v1");
  assert.equal(persistedRequest.request_id, "visual-request-1");
  assert.equal(persistedRequest.match_session_id, "match-1");
  assert.equal(persistedRequest.request_kind, "hard_data_query");
  assert.equal(persistedRequest.origin_action_id, "cruise_no_big_data");
  assert.equal(persistedRequest.evidence_policy_id, "active_core_profile_only");
  assert.equal(persistedRequest.stage_round, "4-2");
  assert.equal(persistedRequest.decision_snapshot_fingerprint, "snapshot-1");
  assert.equal(JSON.stringify(persistedState).includes(sentinel), false);

  const daemon = Object.create(JccRuntimeDaemon.prototype);
  daemon.store = store;
  daemon.applyMatchSessionBoundary = () => {};
  daemon.emitCommittedRuntimeEvent = () => {};
  const daemonResult = daemon.persistResult("sendMessage", {
    ok: true,
    status: "awaiting_host_cli_agent_response",
    host_request: {
      request_id: "daemon-request-1",
      request_hash: "daemon-request-hash-1",
      mode: "cruise",
      task: `${sentinel}:task-body`,
      user_message: `${sentinel}:user-message-body`,
      runtime_context: { match_session: { match_session_id: "match-1" } },
    },
  });
  assert.equal(daemonResult.host_request.task.includes(sentinel), true, "active in-memory result may retain the complete request");
  const daemonPersistedRef = store.getJson("host_request_latest");
  assert.equal(daemonPersistedRef.schema, "jcc-host-request-ref-v1");
  assert.equal(Object.hasOwn(daemonPersistedRef, "task"), false);
  assert.equal(Object.hasOwn(daemonPersistedRef, "user_message"), false);
  const daemonQueueItem = store.listQueue({ queueName: "host_request", limit: 10 })
    .find((entry) => entry.payload?.request_id === "daemon-request-1");
  assert.equal(daemonQueueItem.payload.schema, "jcc-host-request-ref-v1");
  assert.equal(Object.hasOwn(daemonQueueItem.payload, "task"), false);
  assert.equal(Object.hasOwn(daemonQueueItem.payload, "user_message"), false);

  const bypassPayload = {
    nested: [{
      host_request: {
        request_id: "bypass-request",
        request_hash: "bypass-hash",
        mode: "cruise",
        runtime_context: { match_session: { match_session_id: "match-1" } },
        forbidden: `${sentinel}${"q".repeat(100_000)}`,
      },
    }],
  };
  const queued = store.enqueue("host_request", bypassPayload);
  store.appendEvent("verify_direct_event_sanitization", bypassPayload);
  store.upsertSession("match-1", "match_session", "active", bypassPayload);
  store.appendLog("info", "verify direct log sanitization", bypassPayload);
  assert.equal(store.getQueueItem(queued.id).payload.nested[0].host_request.schema, "jcc-host-request-ref-v1");
  const failureQueue = store.enqueue("host_request_failure", { request_id: "failure-request" });
  const claimedFailure = store.claimQueueItem("host_request_failure", { workerId: "failure-worker" });
  store.failQueueItem(failureQueue.id, bypassPayload, {
    workerId: claimedFailure.locked_by,
    leaseToken: claimedFailure.lease_token,
    leaseGeneration: claimedFailure.lease_generation,
  });
  const failedQueueItem = store.getQueueItem(failureQueue.id);
  assert.equal(failedQueueItem.error.nested[0].host_request.schema, "jcc-host-request-ref-v1");
  const wikiEvent = store.addWikiSourceEvent({ sourceType: "host_request_sanitization", payload: bypassPayload });
  assert.equal(wikiEvent.payload.nested[0].host_request.schema, "jcc-host-request-ref-v1");
  const curationRun = store.recordWikiCurationRun({ input: bypassPayload, output: bypassPayload });
  assert.equal(curationRun.input.nested[0].host_request.schema, "jcc-host-request-ref-v1");
  assert.equal(curationRun.output.nested[0].host_request.schema, "jcc-host-request-ref-v1");

  store.checkpoint("TRUNCATE");
  store.close();
  store = null;
  const sqliteFiles = (await readdir(tempRoot)).filter((name) => name.startsWith("app.sqlite"));
  const sqliteCorpus = Buffer.concat(
    await Promise.all(sqliteFiles.map((name) => readFile(path.join(tempRoot, name)))),
  ).toString("utf8");
  assert.equal(sqliteCorpus.includes(sentinel), false, "canonical SQLite files must not contain full Host request sentinels");
  assert(sqliteCorpus.includes("jcc-host-request-ref-v1"), "canonical SQLite must retain the metadata-only Host request reference");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    schema: "jcc-canonical-host-request-persistence-verification-v1",
    checked: [
      "visual_request_status_host_request_deeply_replaced",
      "queue_event_session_and_log_writers_share_recursive_sanitization",
      "queue_error_and_wiki_writers_share_recursive_sanitization",
      "ranking_strategy_current_turn_sentinels_absent_from_ui_runtime_state",
      "sqlite_file_scan_contains_only_host_request_ref",
      "daemon_latest_queue_and_event_use_canonical_host_request_ref_without_task_or_user_message",
    ],
  }, null, 2)}\n`);
} finally {
  store?.close();
  await rm(tempRoot, { recursive: true, force: true });
}
