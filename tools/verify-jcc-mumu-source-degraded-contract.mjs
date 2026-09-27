import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  configureRuntimeServicePaths,
  getRuntimeServiceState,
  persistWatcherSourceObservation,
  setRuntimeServiceCanonicalStateWriter,
  setRuntimeServiceState,
  updateMatchConnectionFromLiveState,
} from "../ui/electron/runtime-service.js";

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-mumu-source-degraded-"));
try {
  configureRuntimeServicePaths({ dataRoot: tempRoot });
  setRuntimeServiceCanonicalStateWriter(async () => {});
  setRuntimeServiceState({
    schema: "jcc-ui-runtime-state-v1",
    device_connection: { status: "connected", adb_target: { serial: "127.0.0.1:7555" } },
    match_session: { status: "active", match_session_id: "degraded-source-match" },
    match_connection: { status: "waiting_for_live_state" },
    response_task: { status: "idle", revision: 0 },
    response_task_revision: 0,
    runtime_event_detector: {},
  });

  const degradedPersisted = await persistWatcherSourceObservation({
    match_session_id: "degraded-source-match",
    source_revision: 0,
    last_observed_at: null,
  }, "degraded-source-match");
  assert.equal(degradedPersisted, true);
  let runtimeState = getRuntimeServiceState();
  assert.equal(runtimeState.match_connection.status, "waiting_for_live_state");
  assert.equal(runtimeState.match_connection.source_health.adb_connected, true);
  assert.equal(runtimeState.match_connection.source_health.structured_source_status, "waiting_for_gameassist_payload");
  assert.equal(runtimeState.match_connection.source_health.source_revision, 0);

  setRuntimeServiceState({
    ...runtimeState,
    runtime_event_detector: {
      source_cursor: {
        match_session_id: "degraded-source-match",
        source_revision: 10,
        watcher_summary: { stage_round: "6-3" },
      },
    },
  });
  const regressedWatcher = await persistWatcherSourceObservation({
    match_session_id: "degraded-source-match",
    source_revision: 11,
    stage_round: "1-1",
    latest_source_observation: { source_kind: "gameassist", source_name: "fixture" },
  }, "degraded-source-match");
  assert.equal(regressedWatcher, false, "a same-match watcher stage regression must be rejected");
  runtimeState = getRuntimeServiceState();
  assert.equal(runtimeState.runtime_event_detector.source_cursor.source_revision, 10);
  assert.equal(runtimeState.runtime_event_detector.source_cursor.watcher_summary.stage_round, "6-3");
  assert.equal(runtimeState.match_connection.source_health.last_rejected_stage_round, "1-1");

  const connected = updateMatchConnectionFromLiveState({
    match_session_id: "degraded-source-match",
    phase: { stage_round: "6-4", status: 4 },
    economy: { hp: 100, gold: 10, level: 4, xp: "0/10" },
    own_board: { units: [] },
    own_bench: { units: [] },
    shop: { units: [] },
    items: {},
    augments: {},
  }, new Date().toISOString());
  assert.equal(connected, true);
  runtimeState = getRuntimeServiceState();
  assert.equal(runtimeState.match_connection.status, "connected_to_live_match");
  assert.equal(runtimeState.match_connection.source_health.structured_source_status, "live_payload_ready");

  console.log(JSON.stringify({
    ok: true,
    checks: [
      "adb_connected_without_gameassist_is_not_reported_as_adb_failure",
      "zero_source_revision_keeps_waiting_for_live_state",
      "source_health_explains_gameassist_payload_absence",
      "same_match_stage_regression_is_rejected_without_advancing_source_cursor",
      "later_live_payload_promotes_match_connection",
    ],
  }, null, 2));
} finally {
  setRuntimeServiceCanonicalStateWriter(null);
  await rm(tempRoot, { recursive: true, force: true });
}
