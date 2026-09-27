import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JccRuntimeDaemon } from "../ui/electron/runtime-daemon.js";
import { createRuntimePaths } from "../ui/electron/runtime-state-store.js";
import { createActiveCoreProfileSnapshot } from "./jcc_test_core_profile_fixture.mjs";

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-public-action-persistence-"));
const previousDisable = process.env.JCC_UI_DISABLE_CODEX_EXEC;
const previousDataDir = process.env.JCC_RUNTIME_DATA_DIR;
let daemon = null;

function hash(text) {
  return createHash("sha256").update(text).digest("hex");
}

async function removeTempRoot() {
  let lastError = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(tempRoot, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  process.stderr.write(`cleanup warning: ${lastError?.message || lastError}\n`);
}

function activeCruiseState(matchSessionId, seasonVersionSnapshot) {
  return {
    schema: "jcc-ui-runtime-state-v1",
    device_connection: { status: "disconnected", adb_target: null },
    daily_session: { status: "active", mode: "daily_chat", generation: 1 },
    match_session: { status: "active", match_session_id: matchSessionId, season_version_snapshot: seasonVersionSnapshot },
    match_connection: { status: "waiting_for_live_state" },
    response_task: { status: "idle", response_task_id: null, revision: 0 },
    response_task_revision: 0,
    active_mode: "cruise",
    runtime_triggers: { visual_by_stage: {}, equipment_context_prompts: {} },
    runtime_events: { latest: [], last_observed_at: null },
    runtime_event_advice: { handled: {}, retry_pending: {}, last_by_category: {}, last_by_trigger: {} },
    visual_request_status: null,
    host_cli: { provider: "codex", preferred: "codex", available: false },
    host_sessions: {
      daily: { status: "ready", route_id: "daily", context_keys: [] },
      match: { status: "ready", route_id: "match", match_session_id: matchSessionId, context_keys: [] },
    },
    user_preferences: {},
    user_strategy_memory: { strategies: [] },
    match_context: { match_session_id: matchSessionId, recent_user_messages: [] },
  };
}

async function runPublicAction(action, text) {
  const result = await daemon.handleAction(action, { mode: "cruise", text }, null);
  assert.equal(result.ok, true, `${action} must accept the black-box request`);

  const actionQueueItem = daemon.store.listQueue({ queueName: "runtime_action_task", limit: 20 })
    .find((entry) => entry.payload?.action === action);
  assert(actionQueueItem, `${action} must create its daemon action task`);
  assert.equal(Object.hasOwn(actionQueueItem.payload.payload, "text"), false);
  assert.equal(actionQueueItem.payload.payload.text_byte_length, Buffer.byteLength(text, "utf8"));
  assert.equal(actionQueueItem.payload.payload.text_sha256, hash(text));

  const receivedEvent = daemon.store.listRecentEvents(200)
    .find((entry) => entry.event_type === "ui_action_received" && entry.payload?.action === action);
  assert(receivedEvent, `${action} must persist ui_action_received`);
  assert.equal(Object.hasOwn(receivedEvent.payload.payload, "text"), false);
  assert.equal(receivedEvent.payload.payload.text_byte_length, Buffer.byteLength(text, "utf8"));
  assert.equal(receivedEvent.payload.payload.text_sha256, hash(text));

  const inMemoryRecent = result.state?.match_context?.recent_user_messages || [];
  assert(
    inMemoryRecent.some((entry) => entry?.text === text),
    `${action} must retain exact current-turn text in service memory`,
  );
  const persistedRecent = daemon.store.getJson("ui_runtime_state")?.match_context?.recent_user_messages || [];
  assert.equal(persistedRecent.some((entry) => entry?.text === text), false);
  assert(persistedRecent.every((entry) => !entry?.text || entry.text !== text));
  if (persistedRecent.length) assert(persistedRecent.some((entry) => entry?.text_sha256 === hash(text)));
}

try {
  process.env.JCC_UI_DISABLE_CODEX_EXEC = "1";
  process.env.JCC_RUNTIME_DATA_DIR = tempRoot;
  daemon = new JccRuntimeDaemon({ repoRoot: process.cwd(), dataRoot: tempRoot }).start();
  const matchSessionId = "message-persistence-match";
  const runtimePaths = createRuntimePaths(process.cwd(), { dataRoot: tempRoot });
  const seasonVersionSnapshot = createActiveCoreProfileSnapshot(process.cwd(), { runtimePaths });
  daemon.store.setJson("ui_runtime_state", activeCruiseState(matchSessionId, seasonVersionSnapshot));

  const sendMessageSentinel = "JCC_SEND_MESSAGE_SQLITE_SENTINEL_8f04a9c1";
  await runPublicAction("sendMessage", sendMessageSentinel);

  const resetState = {
    ...daemon.store.getJson("ui_runtime_state"),
    response_task: { status: "idle", response_task_id: null },
  };
  daemon.store.setJson("ui_runtime_state", resetState);
  const hardDataSentinel = "JCC_HARD_DATA_SQLITE_SENTINEL_c7831e2b";
  await runPublicAction("sendCruiseHardDataQuery", hardDataSentinel);

  await daemon.handleAction("shutdown", { reason: "verify_public_action_persistence_cleanup" }, null).catch(() => {});
  await daemon.actionChain?.catch?.(() => {});
  daemon.store.checkpoint("TRUNCATE");
  daemon.stop();
  daemon = null;
  await new Promise((resolve) => setTimeout(resolve, 100));

  const sqliteFiles = (await readdir(tempRoot)).filter((name) => name.startsWith("app.sqlite"));
  const sqliteCorpus = Buffer.concat(
    await Promise.all(sqliteFiles.map((name) => readFile(path.join(tempRoot, name)))),
  ).toString("utf8");
  for (const sentinel of [sendMessageSentinel, hardDataSentinel]) {
    assert.equal(sqliteCorpus.includes(sentinel), false, `SQLite must not contain ${sentinel}`);
    assert(sqliteCorpus.includes(hash(sentinel)), "SQLite must retain the message hash audit");
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    schema: "jcc-public-action-message-persistence-verification-v1",
    checked: [
      "sendMessage_action_task_and_ui_action_received_are_metadata_only",
      "sendCruiseHardDataQuery_action_task_and_ui_action_received_are_metadata_only",
      "current_turn_service_memory_retains_exact_text",
      "recent_user_messages_persist_only_hash_length_and_bounded_intent_metadata",
      "sqlite_database_wal_and_shm_black_box_scan_exclude_both_sentinels",
    ],
  }, null, 2)}\n`);
} finally {
  if (daemon?.started) {
    await daemon.handleAction("shutdown", { reason: "verify_public_action_persistence_finally" }, null).catch(() => {});
    await daemon.actionChain?.catch?.(() => {});
  }
  daemon?.stop();
  if (previousDisable === undefined) delete process.env.JCC_UI_DISABLE_CODEX_EXEC;
  else process.env.JCC_UI_DISABLE_CODEX_EXEC = previousDisable;
  if (previousDataDir === undefined) delete process.env.JCC_RUNTIME_DATA_DIR;
  else process.env.JCC_RUNTIME_DATA_DIR = previousDataDir;
  await removeTempRoot();
}
