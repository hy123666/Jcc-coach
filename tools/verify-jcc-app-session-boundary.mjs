import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JccRuntimeDaemon, mergeRuntimeServiceCanonicalSnapshot } from "../ui/electron/runtime-daemon.js";
import { getRuntimeServiceState } from "../ui/electron/runtime-service.js";

const root = path.resolve(import.meta.dirname, "..");
const dataRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-app-session-boundary-"));
let daemon;
try {
  daemon = new JccRuntimeDaemon({ repoRoot: root, dataRoot }).start();
  const old = {
    ...getRuntimeServiceState(),
    runtime_lifecycle: { clean_shutdown: false, app_launch_id: "previous-app" },
    active_mode: "cruise",
    daily_session: { generation: 4, status: "inactive" },
    match_session: { status: "active", match_session_id: "old-match", ui_ready: true },
    match_context: { match_session_id: "old-match", latest_authoritative_facts: { stage_round: "6-1" } },
    host_sessions: {
      daily: { route_key: "daily:4", provider_session_id: "old-lobby", runtime_instance_id: "old-runtime" },
      match: { route_key: "match:old-match", provider_session_id: "old-match-provider" },
    },
    watcher: { status: "idle", pid: null },
    response_task: { status: "idle", revision: 0 },
  };
  daemon.store.setJson("ui_runtime_state", old);
  daemon.store.setJson("response_task", old.response_task);
  daemon.store.upsertSession("old-match", "match_session", "active", old.match_session);
  daemon.store.setJson("manual_match_variables_latest", { stage_round: "6-1" });
  const queued = daemon.store.enqueue("host_request", { match_session_id: "old-match" }, "pending",
    { scopeType: "match", scopeSessionId: "old-match" });
  const boot = await daemon.handleAction("bootstrap", { testMode: true, app_launch_id: "app-a" });
  assert.equal(boot.ok, true);
  const fresh = daemon.store.getJson("ui_runtime_state");
  assert.equal(fresh.match_session.status, "idle");
  assert.equal(fresh.match_session.match_session_id, null);
  assert.equal(fresh.active_mode, "daily_chat");
  assert.equal(fresh.match_context, null);
  assert.equal(fresh.daily_session.generation, 5);
  assert.equal(fresh.host_sessions.daily.provider_session_id, null);
  assert.equal(fresh.host_sessions.match.provider_session_id, null);
  assert.equal(daemon.store.getQueueItem(queued.id).status, "cancelled");
  assert.equal(daemon.store.getJson("manual_match_variables_latest", null), null);
  assert.equal(daemon.store.db.prepare("SELECT status FROM runtime_sessions WHERE session_id = ?").get("old-match").status, "stopped");
  const late = daemon.persistRuntimeServiceCanonicalSnapshot(old, { event_type: "hud_facts_changed" });
  assert.equal(late.applied, false, "old Match completion must not restore lobby state");
  assert.equal(mergeRuntimeServiceCanonicalSnapshot(fresh, fresh, {
    event_type: "app_session_boundary_started",
    event_payload: { previous_match_session_id: "old-match", previous_daily_session_generation: 4 },
  }).applied, false, "a duplicate stale boundary must not commit again");

  await daemon.handleAction("bootstrap", { testMode: true, app_launch_id: "app-a" });
  assert.equal(daemon.store.getJson("ui_runtime_state").daily_session.generation, 5, "renderer reload must be idempotent");
  const live = daemon.store.getJson("ui_runtime_state");
  live.match_session = { status: "active", match_session_id: "new-live-match", ui_ready: true };
  live.active_mode = "cruise";
  live.host_sessions.match = { route_key: "match:new-live-match", provider_session_id: "new-provider" };
  daemon.store.setJson("ui_runtime_state", live);
  await daemon.handleAction("bootstrap", { testMode: true, app_launch_id: "app-a" });
  assert.equal(daemon.store.getJson("ui_runtime_state").match_session.match_session_id, "new-live-match", "renderer reload must not retire the current Match");
  await daemon.handleAction("bootstrap", { testMode: true, app_launch_id: "app-b" });
  assert.equal(daemon.store.getJson("ui_runtime_state").daily_session.generation, 6, "new Electron process must rotate even with the same daemon");
  assert.equal(daemon.store.getJson("ui_runtime_state").match_session.match_session_id, null);
  console.log(JSON.stringify({ ok: true, checked: ["unclean-restart-retires-match", "old-queue-cancelled", "late-completion-rejected", "same-app-reuse", "new-app-fresh-lobby"] }));
} finally {
  daemon?.stop();
  await rm(dataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
