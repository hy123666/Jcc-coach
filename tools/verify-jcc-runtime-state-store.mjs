import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createRuntimePaths,
  createRuntimeSqliteStore,
  readDurableJson,
  readJson,
  runtimeStoreContract,
  writeLegacyJsonMirror,
  writeJsonAtomic,
} from "../ui/electron/runtime-state-store.js";
import { configureRuntimeServicePaths } from "../ui/electron/runtime-service.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readText(file) {
  return readFile(file, "utf8");
}

function assertIncludes(source, needle, label) {
  assert(source.includes(needle), `${label} must include ${needle}`);
}

function assertNotIncludes(source, needle, label) {
  assert(!source.includes(needle), `${label} must not include ${needle}`);
}

async function main() {
  const repoRoot = process.cwd();
  const service = await readText("ui/electron/runtime-service.js");
  const store = await readText("ui/electron/runtime-state-store.js");

  assert(runtimeStoreContract.schema === "jcc-runtime-state-store-v5", "store contract schema mismatch");
  assert(runtimeStoreContract.owner === "jcc-runtime-orchestrator", "runtime must own state");
  assert(runtimeStoreContract.host_cli_policy.includes("thin_adapter"), "host CLI must be thin adapter");
  assert(runtimeStoreContract.database_file === "app.sqlite", "runtime store must declare app.sqlite");
  assert(runtimeStoreContract.sqlite_runtime === "node:sqlite", "runtime store must use node:sqlite");

  for (const needle of [
    "createRuntimePaths",
    "createRuntimeSqliteStore",
    "JccRuntimeSqliteStore",
    "DatabaseSync",
    "app.sqlite",
    "runtime_kv",
    "runtime_events",
    "runtime_sessions",
    "runtime_queue",
    "runtime_migrations",
    "runtime_logs",
    "wiki_source_events",
    "wiki_pages",
    "wiki_curation_runs",
    "addWikiSourceEvent",
    "upsertWikiPage",
    "listWikiPages",
    "markWikiPagesStale",
    "recordWikiCurationRun",
    "queue_policy",
    "claimQueueItem",
    "completeQueueItem",
    "failQueueItem",
    "recoverStaleQueueItems",
    "JCC_RUNTIME_DATA_DIR",
    "runtimeDataRoot",
    "uiRuntimeDir",
    "currentWatchDir",
    "currentSessionFile",
    "uiStateFile",
    "userSettingsFile",
    "userMemoryFile",
    "matchContextFile",
    "writeJsonAtomic",
    "writeLegacyJsonMirror",
    "isTransientWindowsFileLock",
    "retryTransientFileOperation",
    "readJson",
    "readDurableJson",
    "JCC_DURABLE_JSON_CORRUPT",
  ]) {
    assertIncludes(store, needle, "runtime state store");
  }
  assertIncludes(store, "${process.pid}.${Date.now()}.${randomUUID()}.tmp", "runtime state store atomic writer should use collision-resistant temp files");
  assertIncludes(store, "retryTransientFileOperation(() => rename(temp, resolved))", "runtime state store atomic writer should retry transient Windows rename failures");
  assertIncludes(store, "[\"EPERM\", \"EBUSY\", \"EACCES\", \"ENOTEMPTY\"]", "runtime state store must classify transient Windows/OneDrive file locks");

  for (const needle of [
    "import {",
    "createRuntimePaths",
    "} from \"./runtime-state-store.js\"",
    "let runtimePaths = createRuntimePaths(repoRoot)",
    "function configureRuntimeServicePaths",
  ]) {
    assertIncludes(service, needle, "runtime service");
  }
  const daemon = await readText("ui/electron/runtime-daemon.js");
  assertIncludes(daemon, "configureRuntimeServicePaths({ dataRoot })", "runtime daemon should bind runtime service to daemon dataRoot before handling actions");
  assertIncludes(service, "ignored_legacy_json_mirror_write_failure", "runtime service must not break match flow on best-effort legacy mirror write failures");
  assertIncludes(service, "recordLegacyStateMirrorWriteFailure(error, pending.file)", "runtime service should record ignored legacy mirror failures for diagnostics");
  assertIncludes(service, "await waitForRuntimeLegacyStateMirrors()", "clean shutdown should wait for the final coalesced legacy mirror write");
  for (const [start, end, label] of [
    ["async function saveUserPreferences", "function normalizeRuntimeSettings", "user preferences"],
    ["async function saveStrategyMemory", "async function buildWikiCurationRequest", "strategy memory"],
  ]) {
    const startIndex = service.indexOf(start);
    const endIndex = service.indexOf(end, startIndex + start.length);
    assert(startIndex >= 0 && endIndex > startIndex, `${label} save boundary is missing`);
    const body = service.slice(startIndex, endIndex);
    const canonicalWrite = body.indexOf("await persistStateAndCanonicalResponseTask()");
    const legacyMirror = body.indexOf("scheduleLegacyJsonMirror(");
    assert(canonicalWrite >= 0, `${label} must persist canonical SQLite state`);
    assert(legacyMirror > canonicalWrite, `${label} must update SQLite before scheduling a best-effort legacy JSON mirror`);
    assert(!body.includes("runNodeTool("), `${label} must not round-trip through a legacy JSON helper before canonical persistence`);
  }

  for (const forbidden of [
    "async function readJson",
    "async function writeJsonAtomic",
    "async function ensureDir",
    "const uiRuntimeDir = path.join(repoRoot, \".omx\"",
    "const currentSessionFile = path.join(repoRoot, \".omx\"",
    "PowerShell",
    "Set-Content",
  ]) {
    assertNotIncludes(service, forbidden, "runtime service");
  }

  const configuredPaths = createRuntimePaths(repoRoot);
  if (process.env.JCC_RUNTIME_DATA_DIR) {
    assert(
      configuredPaths.runtimeDataRoot === path.resolve(process.env.JCC_RUNTIME_DATA_DIR),
      "JCC_RUNTIME_DATA_DIR must override the default runtime data root",
    );
  }
  const previousRuntimeDataDir = process.env.JCC_RUNTIME_DATA_DIR;
  delete process.env.JCC_RUNTIME_DATA_DIR;
  const defaultPaths = createRuntimePaths(repoRoot);
  if (previousRuntimeDataDir !== undefined) process.env.JCC_RUNTIME_DATA_DIR = previousRuntimeDataDir;
  assert(defaultPaths.runtimeDataRoot.endsWith(".jcc-runtime-data"), "default runtime data root should be independent .jcc-runtime-data");
  assert(defaultPaths.sqliteFile.endsWith(path.join(".jcc-runtime-data", "app.sqlite")), "default sqlite file should live under runtime data root");
  assert(defaultPaths.uiRuntimeDir.includes(path.join(".jcc-runtime-data", "runtime-evidence", "ui-runtime")), "default ui runtime dir mismatch");
  assert(defaultPaths.legacyUiStateFile.endsWith(path.join(".omx", "state", "jcc-ui-runtime-state.json")), "legacy .omx state mirror should remain migration source");
  assert(defaultPaths.activeRuntimeIdentityAuthority === "core_profile", "runtime paths must expose Core Profile as the only active identity authority");
  assert(defaultPaths.activeRuntimeIdentity?.season_id === defaultPaths.activeSeasonId, "active runtime identity must own the selected season");
  assert(defaultPaths.activeRuntimeIdentity?.patch_id === defaultPaths.activePatchId, "active runtime identity must own the selected patch");
  assert(defaultPaths.baseGameRulesFile === undefined, "runtime paths must not expose the old base-game rules authority");
  assert(defaultPaths.seasonNormalRulesFile === undefined, "runtime paths must not expose the old season normal-rules authority");
  assert(defaultPaths.seasonSpecialRulesFile === undefined, "runtime paths must not expose the old season special-rules authority");
  assert(!Object.hasOwn(defaultPaths, "legacyBaseGameRuleFixtureFile"), "legacy base-game fallback must be absent");
  assert(!Object.hasOwn(defaultPaths, "legacySeasonNormalRuleFixtureFile"), "legacy normal-rule fallback must be absent");
  assert(!Object.hasOwn(defaultPaths, "legacySeasonSpecialRuleFixtureFile"), "legacy special-rule fallback must be absent");

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-runtime-store-"));
  let sqlite = null;
  try {
    const customPaths = createRuntimePaths(repoRoot, { dataRoot: tempRoot });
    assert(customPaths.runtimeDataRoot === path.resolve(tempRoot), "custom runtime data root mismatch");
    assert(customPaths.sqliteFile === path.join(path.resolve(tempRoot), "app.sqlite"), "custom sqlite file mismatch");
    assert(customPaths.uiStateFile.startsWith(path.resolve(tempRoot)), "custom state should live under runtime data root");
    const servicePaths = configureRuntimeServicePaths({ dataRoot: tempRoot });
    assert(servicePaths.runtimeDataRoot === customPaths.runtimeDataRoot, "runtime service must bind to the requested daemon data root");
    assert(servicePaths.sqliteFile === customPaths.sqliteFile, "runtime service must use the rebound daemon SQLite path");

    const sampleFile = path.join(customPaths.stateDir, "sample.json");
    await writeJsonAtomic(sampleFile, { ok: true, text: "ezreal" });
    const raw = await readFile(sampleFile);
    assert(!(raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf), "JSON writer must not emit UTF-8 BOM");
    const parsed = await readJson(sampleFile, null);
    assert(parsed?.ok === true && parsed.text === "ezreal", "JSON roundtrip failed");
    const mirrorFile = path.join(customPaths.stateDir, "mirror.json");
    await writeLegacyJsonMirror(mirrorFile, { ok: true });
    const mirror = await readJson(mirrorFile, null);
    assert(mirror?._runtime_storage_note?.canonical_store === "app.sqlite", "legacy JSON mirror must declare app.sqlite canonical store");

    const corruptFile = path.join(customPaths.stateDir, "corrupt.json");
    await writeJsonAtomic(corruptFile, { ok: true });
    await import("node:fs/promises").then(({ writeFile }) => writeFile(corruptFile, "{bad json", "utf8"));
    let corruptError = null;
    try {
      await readDurableJson(corruptFile, null);
    } catch (error) {
      corruptError = error;
    }
    assert(corruptError?.code === "JCC_DURABLE_JSON_CORRUPT", "durable JSON corruption must surface an explicit error");

    sqlite = createRuntimeSqliteStore(repoRoot, { dataRoot: tempRoot }).open();
    sqlite.setJson("user_preferences", { rank_tier: "challenger" });
    assert(sqlite.getJson("user_preferences").rank_tier === "challenger", "sqlite kv roundtrip failed");
    const event = sqlite.appendEvent("verify_event", { ok: true });
    assert(event.id > 0, "sqlite event insert failed");
    sqlite.upsertSession("daily", "daily_session", "active", { status: "active" });
    sqlite.upsertSession("match-1", "match_session", "active", { match_session_id: "match-1" });
    sqlite.upsertSession("match-2", "match_session", "active", { match_session_id: "match-2" });
    const closedOtherSessions = sqlite.closeOtherActiveMatchSessions("match-2", "superseded");
    assert(closedOtherSessions.some((entry) => entry.session_id === "match-1"), "session lifecycle must close superseded active matches");
    assert(sqlite.db.prepare("SELECT status FROM runtime_sessions WHERE session_id = 'match-1'").get()?.status === "superseded", "superseded session must not remain active");
    for (let index = 0; index < 22; index += 1) {
      const sessionId = `review-match-${String(index).padStart(2, "0")}`;
      sqlite.upsertSession(sessionId, "match_session", "active", { match_session_id: sessionId });
      sqlite.closeSession(sessionId, "stopped", {
        closed_reason: "verification",
        postgame_summary: {
          schema: "jcc-postgame-decision-summary-v1",
          match_session_id: sessionId,
          ended_at: `2026-08-18T00:${String(index).padStart(2, "0")}:00.000Z`,
          advice_tasks: [{ task_id: `task-${index}`, short_advice: "compact" }],
          storage_policy: {
            store_structured_decision_summary_only: true,
            store_raw_screenshots: false,
            store_full_raw_logs: false,
            store_full_live_state: false,
          },
        },
      });
    }
    sqlite.pruneClosedMatchSessions(20);
    const recentSummaries = sqlite.listRecentMatchSummaries(20);
    assert(recentSummaries.length === 20, "canonical SQLite review retention must keep only the latest 20 match summaries");
    assert(recentSummaries.every((entry) => entry.schema === "jcc-postgame-decision-summary-v1"), "closed match rows must expose compact postgame summaries");
    assert(recentSummaries.every((entry) => entry.full_live_state === undefined && entry.screenshot === undefined), "review summaries must not retain full live state or screenshots");
    sqlite.upsertSession("oversized-review-match", "match_session", "active", { match_session_id: "oversized-review-match" });
    sqlite.closeSession("oversized-review-match", "stopped", {
      postgame_summary: {
        schema: "jcc-postgame-decision-summary-v1",
        match_session_id: "oversized-review-match",
        confirmed_choices: [{ selected_name: "x".repeat(400000) }],
        economy_milestones: {
          stage_round: "x".repeat(400000),
          hp: "x".repeat(400000),
          gold: "x".repeat(400000),
          level: "x".repeat(400000),
          xp: "x".repeat(400000),
        },
      },
    });
    const guardedSummary = JSON.parse(sqlite.db.prepare("SELECT payload_json FROM runtime_sessions WHERE session_id = 'oversized-review-match'").get()?.payload_json || "{}").postgame_summary;
    assert(Buffer.byteLength(JSON.stringify(guardedSummary), "utf8") <= 256 * 1024, "state store must enforce the postgame summary hard limit for every caller");
    assert(guardedSummary.storage_policy?.state_store_guard_applied === true, "state store must mark fallback compaction when a caller bypasses the Runtime builder");
    assert(Object.values(guardedSummary.economy_milestones || {}).every((value) => typeof value !== "string" || value.length <= 300), "state store must bound every retained economy milestone string");
    const queued = sqlite.enqueue("visual_request", { mode: "augment_choice" });
    assert(queued.id > 0 && queued.status === "pending", "sqlite queue insert failed");
    const claimed = sqlite.claimQueueItem("visual_request", { workerId: "verify-worker", leaseMs: 10 });
    assert(claimed.id === queued.id && claimed.status === "running" && claimed.attempts === 1, "sqlite queue claim failed");
    const failedRetry = sqlite.failQueueItem(queued.id, { code: "VERIFY_RETRY" }, {
      workerId: claimed.locked_by,
      leaseToken: claimed.lease_token,
      leaseGeneration: claimed.lease_generation,
    });
    assert(failedRetry.status === "retry", "sqlite queue fail should retry before max attempts");
    const claimedAgain = sqlite.claimQueueItem("visual_request", { workerId: "verify-worker-2", leaseMs: 10 });
    assert(claimedAgain.id === queued.id && claimedAgain.attempts === 2, "sqlite queue retry claim failed");
    const completed = sqlite.completeQueueItem(queued.id, { result: "ok" }, {
      workerId: claimedAgain.locked_by,
      leaseToken: claimedAgain.lease_token,
      leaseGeneration: claimedAgain.lease_generation,
    });
    assert(completed.status === "completed" && completed.payload.result === "ok", "sqlite queue complete failed");
    const staleQueued = sqlite.enqueue("visual_request", { mode: "stale" }, "pending", { maxAttempts: 1 });
    sqlite.claimQueueItem("visual_request", { workerId: "stale-worker", leaseMs: 1 });
    const recovered = sqlite.recoverStaleQueueItems({ staleMs: 0, limit: 10 });
    assert(recovered.some((row) => row.id === staleQueued.id && row.status === "failed"), "sqlite stale queue recovery failed");
    const updatedQueue = sqlite.updateQueueItem(queued.id, "completed", { result: "ok-again" });
    assert(updatedQueue.status === "completed" && updatedQueue.payload.result === "ok-again", "sqlite queue update failed");
    assert(sqlite.listQueue({ queueName: "visual_request" }).some((row) => row.id === queued.id), "sqlite queue inspect failed");
    sqlite.appendLog("info", "verify log", { ok: true });
    assert(sqlite.listLogs(5).some((row) => row.message === "verify log"), "sqlite structured logs failed");
    for (let index = 0; index < 5; index += 1) {
      sqlite.appendEvent(`retention-event-${index}`, { index });
      sqlite.appendLog("debug", `retention-log-${index}`, { index });
      sqlite.enqueue("advice_task_lifecycle", { index, large_snapshot: "x".repeat(1024) }, "observed");
      sqlite.enqueue("runtime_action_task", { index }, "completed");
    }
    const liveQueue = sqlite.enqueue("runtime_action_task", { must_survive: true }, "pending");
    const matchOneQueue = sqlite.enqueue("host_request", { match_session_id: "match-1" }, "pending", {
      scopeType: "match",
      scopeSessionId: "match-1",
    });
    const matchTwoQueue = sqlite.enqueue("host_request", { match_session_id: "match-2" }, "pending", {
      scopeType: "match",
      scopeSessionId: "match-2",
    });
    const globalMentionQueue = sqlite.enqueue("runtime_action_task", {
      note: "diagnostic text mentions match-1 but does not belong to it",
    }, "pending", { scopeType: "global" });
    const retiredMatchQueue = sqlite.settleMatchQueueItems("match-1", { reason: "verify_match_closed" });
    assert(retiredMatchQueue.includes(matchOneQueue.id), "match close must retire its scoped queue work");
    assert(sqlite.getQueueItem(matchOneQueue.id).status === "cancelled", "retired match queue item must become terminal");
    assert(sqlite.getQueueItem(matchTwoQueue.id).status === "pending", "closing one match must not retire another match's queue work");
    assert(sqlite.getQueueItem(globalMentionQueue.id).status === "pending", "arbitrary text mentioning a match id must not retire global queue work");
    const oversizedEvent = sqlite.appendEvent("oversized-event", {
      match_session_id: "match-1",
      response_task_id: "task-1",
      nested: "x".repeat(1024 * 1024),
    });
    assert(oversizedEvent.payload.payload_truncated === true, "oversized SQLite event payloads must be compacted before persistence");
    assert(oversizedEvent.payload.original_payload_bytes > 1024 * 1024, "compacted event must preserve original byte evidence");
    const staleNonterminal = sqlite.enqueue("visual_request", { match_session_id: "legacy-match" }, "requested");
    sqlite.db.prepare("UPDATE runtime_queue SET updated_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", staleNonterminal.id);
    assert(sqlite.expireStaleNonterminalQueueItems({ staleMs: 60000 }) >= 1, "stale nonterminal queue work must expire");
    assert(sqlite.getQueueItem(staleNonterminal.id).status === "cancelled", "expired nonterminal queue work must become terminal");
    const retention = sqlite.enforceRetentionBudget({
      keepEvents: 2,
      keepLogs: 2,
      keepTerminalQueuePerName: 2,
      queueOverrides: { advice_task_lifecycle: 1 },
    });
    assert(retention.deleted.runtime_events >= 4, "retention must prune old runtime events");
    assert(retention.deleted.runtime_logs >= 4, "retention must prune old runtime logs");
    assert(sqlite.listQueue({ queueName: "advice_task_lifecycle", limit: 20 }).length === 1, "retention must aggressively bound lifecycle diagnostics");
    assert(sqlite.listQueue({ queueName: "runtime_action_task", status: "pending", limit: 20 }).some((row) => row.id === liveQueue.id), "retention must never delete live queue work");
    assert(sqlite.getJson("user_preferences").rank_tier === "challenger", "retention must preserve canonical user preferences");
    const checkpoint = sqlite.checkpoint("PASSIVE");
    assert(checkpoint.ok === true && checkpoint.mode === "PASSIVE", "store must expose a bounded WAL checkpoint operation");
    assert(sqlite.listMigrations().some((entry) => entry.version === 7), "match-session queue scope migration must be recorded");
    const sourceEvent = sqlite.addWikiSourceEvent({
      sourceType: "verify_source",
      namespace: "personal_strategy",
      seasonId: "s17",
      patchId: "17.5b",
      payload: { ok: true },
    });
    const wikiPage = sqlite.upsertWikiPage({
      namespace: "personal_strategy",
      category: "patch_meta_strategy",
      season_id: "s17",
      patch_id: "17.5b",
      title: "Verify wiki page",
      status: "published",
      source_event_ids: [sourceEvent.id],
      tags: ["verify"],
    });
    assert(wikiPage.source_event_ids[0] === sourceEvent.id, "sqlite wiki page source ids failed");
    const stale = sqlite.markWikiPagesStale({ seasonId: "s17", olderThanPatch: "17.5c" });
    assert(stale.changed >= 1, "sqlite wiki stale marker failed");
    const curationRun = sqlite.recordWikiCurationRun({
      status: "completed",
      input: { source_event_ids: [sourceEvent.id] },
      output: { page_ids: [wikiPage.page_id] },
    });
    assert(curationRun.output.page_ids[0] === wikiPage.page_id, "sqlite wiki curation run failed");
    const staleWikiRun = sqlite.recordWikiCurationRun({
      status: "pending_host_model",
      input: { source_event_ids: [sourceEvent.id] },
    });
    sqlite.db.prepare("UPDATE wiki_curation_runs SET created_at = ? WHERE run_id = ?")
      .run("2020-01-01T00:00:00.000Z", staleWikiRun.run_id);
    for (let index = 0; index < 5; index += 1) {
      sqlite.recordWikiCurationRun({
        status: "completed",
        input: { source_event_ids: [sourceEvent.id] },
        output: { sequence: index },
      });
      sqlite.addWikiSourceEvent({
        sourceType: `verify_unreferenced_${index}`,
        namespace: "personal_strategy",
        seasonId: "s17",
        patchId: "17.5b",
        payload: { sequence: index },
      });
    }
    const events = sqlite.listRecentEvents(5);
    assert(events.length <= 5, "sqlite recent event listing exceeded its requested bound");
    const finalRetention = sqlite.enforceRetentionBudget({
      keepEvents: 2,
      keepLogs: 2,
      keepTerminalQueuePerName: 2,
      keepTerminalQueueTotal: 3,
      keepWikiCurationRuns: 2,
      keepUnreferencedWikiSourceEvents: 1,
      wikiPendingMaxAgeMs: 60_000,
    });
    assert(sqlite.db.prepare("SELECT page_id FROM wiki_pages WHERE page_id = ?").get(wikiPage.page_id)?.page_id === wikiPage.page_id, "retention must preserve curated review/wiki state");
    assert(sqlite.db.prepare("SELECT id FROM wiki_source_events WHERE id = ?").get(sourceEvent.id)?.id === sourceEvent.id, "retention must preserve source events referenced by wiki pages");
    assert(sqlite.db.prepare("SELECT COUNT(*) AS count FROM wiki_source_events WHERE id <> ?").get(sourceEvent.id).count <= 1, "retention must bound unreferenced wiki source events");
    assert(sqlite.db.prepare("SELECT COUNT(*) AS count FROM wiki_curation_runs").get().count <= 2, "retention must bound terminal wiki curation runs");
    assert(finalRetention.deleted.wiki_curation_runs_expired >= 1, "retention must expire abandoned wiki curation runs");
    assert(sqlite.db.prepare("SELECT COUNT(*) AS count FROM runtime_queue WHERE status IN ('completed', 'observed', 'failed', 'cancelled', 'superseded')").get().count <= 3, "retention must enforce a global terminal queue limit");
  } finally {
    sqlite?.close();
    configureRuntimeServicePaths({ dataRoot: configuredPaths.runtimeDataRoot });
    await rm(tempRoot, { recursive: true, force: true });
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    checked: ["runtime-state-store-v5", "sqlite-store", "sqlite-migrations", "queue-claim-complete-fail-recover", "queue-match-session-scope", "stale-nonterminal-queue-expiry", "match-session-close", "queue-inspect", "structured-logs", "strategy-wiki-tables", "canonical-before-legacy-user-settings", "canonical-before-legacy-strategy-memory", "legacy-json-mirror", "runtime-service-boundary"],
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
