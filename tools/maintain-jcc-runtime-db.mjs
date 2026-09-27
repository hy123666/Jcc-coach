import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateRegisteredRetiredSeason } from "./archive-jcc-season.mjs";
import { createRuntimeSqliteStore } from "../ui/electron/runtime-state-store.js";
import {
  compactAdviceTaskLifecycle,
  compactPersistedResponseTask,
} from "../ui/electron/runtime-daemon.js";
import { inspectWriterLeaseOwner } from "../ui/electron/runtime-writer-lease.js";

const defaultRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readArg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const repoRoot = path.resolve(readArg("--repo-root", defaultRepoRoot));
const runtimeDataRoot = path.resolve(readArg("--runtime-data-root", process.env.JCC_RUNTIME_DATA_DIR || path.join(repoRoot, ".jcc-runtime-data")));
const seasonId = readArg("--season-id");
const args = new Set(process.argv.slice(2));
const shouldVacuum = args.has("--vacuum");
const resetRetiredVersionRuntime = args.has("--reset-retired-version-runtime");

const RETIRED_VERSION_TRANSIENT_KV = new Set([
  "advice_task_lifecycle_latest",
  "host_request_latest",
  "host_response_latest",
  "manual_match_variables_latest",
  "match_session_current",
  "response_task",
  "response_task_revision",
  "runtime_daemon_contract",
  "runtime_daemon_health",
  "runtime_daemon_info",
  "runtime_storage_maintenance_latest",
  "ui_runtime_state",
  "ui_state",
]);

const RETIRED_VERSION_TRANSIENT_KV_PREFIXES = ["context_pack:"];

function isRetiredVersionTransientKv(key) {
  return RETIRED_VERSION_TRANSIENT_KV.has(key)
    || RETIRED_VERSION_TRANSIENT_KV_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function assertOfflineWriter(paths) {
  const leaseFile = path.join(paths.runtimeDataRoot, "runtime-daemon", "writer-lease.json");
  if (!existsSync(leaseFile)) return;
  let lease = null;
  try {
    lease = JSON.parse(readFileSync(leaseFile, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    throw new Error(`Refusing database maintenance because the writer lease is unreadable: ${leaseFile}`);
  }
  const ownerStatus = inspectWriterLeaseOwner(lease);
  if (ownerStatus.status === "active") {
    throw new Error(`Refusing database maintenance while JCC Runtime writer PID ${lease.pid} is active. Stop JCC Runtime first.`);
  }
  if (ownerStatus.status === "unverifiable") {
    throw new Error(`Refusing database maintenance because JCC Runtime writer PID ${lease?.pid ?? "unknown"} cannot be verified safely.`);
  }
}

function fileBytes(file) {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

function writeResetReceipt(paths, retiredSeason) {
  const receiptFile = path.join(paths.runtimeDataRoot, "maintenance", "retired-version-db-reset-receipt.json");
  const temporary = `${receiptFile}.${process.pid}.${Date.now()}.tmp`;
  const receipt = {
    schema: "jcc-retired-version-db-reset-receipt-v1",
    season_id: retiredSeason.season_id,
    archive_relative_path: retiredSeason.archive_relative_path,
    archive_manifest_sha256: retiredSeason.archive_manifest_sha256,
    final_core_profile_id: retiredSeason.final_core_profile_id,
    sqlite_file: path.resolve(paths.sqliteFile),
    completed_at: new Date().toISOString(),
  };
  mkdirSync(path.dirname(receiptFile), { recursive: true });
  try {
    writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    renameSync(temporary, receiptFile);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return { receipt, receipt_file: receiptFile };
}

function tableSummary(store) {
  const rows = store.db.prepare(`
    SELECT 'runtime_events' AS name, COUNT(*) AS rows FROM runtime_events
    UNION ALL SELECT 'runtime_logs', COUNT(*) FROM runtime_logs
    UNION ALL SELECT 'runtime_queue', COUNT(*) FROM runtime_queue
    UNION ALL SELECT 'runtime_kv', COUNT(*) FROM runtime_kv
    UNION ALL SELECT 'wiki_pages', COUNT(*) FROM wiki_pages
  `).all();
  return Object.fromEntries(rows.map((row) => [row.name, Number(row.rows)]));
}

function clearRetiredVersionRuntime(store) {
  const deleted = {};
  let staleKeys = [];
  store.db.exec("BEGIN IMMEDIATE");
  try {
    deleted.runtime_events = store.db.prepare("DELETE FROM runtime_events").run().changes;
    deleted.runtime_logs = store.db.prepare("DELETE FROM runtime_logs").run().changes;
    deleted.runtime_queue = store.db.prepare("DELETE FROM runtime_queue").run().changes;
    deleted.match_sessions = store.db.prepare("DELETE FROM runtime_sessions WHERE session_type = 'match_session'").run().changes;
    deleted.wiki_curation_runs = store.db.prepare("DELETE FROM wiki_curation_runs").run().changes;
    deleted.wiki_source_events = store.pruneUnreferencedWikiSourceEvents(0);
    const kvRows = store.db.prepare("SELECT key FROM runtime_kv").all();
    staleKeys = kvRows.map((row) => String(row.key)).filter(isRetiredVersionTransientKv);
    deleted.runtime_kv = 0;
    for (const key of staleKeys) {
      deleted.runtime_kv += store.db.prepare("DELETE FROM runtime_kv WHERE key = ?").run(key).changes;
    }
    store.db.exec("COMMIT");
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
  return {
    schema: "jcc-retired-version-runtime-reset-v1",
    deleted_runtime_kv_keys: staleKeys.sort(),
    preserved: ["daily_session", "user_preferences", "runtime_settings", "user_strategy_memory", "user_memory", "wiki_pages", "unregistered_future_durable_kv"],
    deleted,
  };
}

const retiredSeason = resetRetiredVersionRuntime
  ? await validateRegisteredRetiredSeason({ repoRoot, seasonId })
  : null;
const store = createRuntimeSqliteStore(defaultRepoRoot, { dataRoot: runtimeDataRoot });
try {
  assertOfflineWriter(store.paths);
  store.open();
  const before = {
    files: {
      sqlite: fileBytes(store.paths.sqliteFile),
      wal: fileBytes(`${store.paths.sqliteFile}-wal`),
      shm: fileBytes(`${store.paths.sqliteFile}-shm`),
    },
    tables: tableSummary(store),
  };
  const retiredVersionReset = resetRetiredVersionRuntime ? clearRetiredVersionRuntime(store) : null;
  const responseTask = store.getJson("response_task", null);
  if (responseTask) store.setJson("response_task", compactPersistedResponseTask(responseTask));
  const runtimeState = store.getJson("ui_runtime_state", null);
  if (runtimeState?.response_task) {
    store.setJson("ui_runtime_state", {
      ...runtimeState,
      response_task: compactPersistedResponseTask(runtimeState.response_task),
    });
  }
  const lifecycle = store.getJson("advice_task_lifecycle_latest", null);
  if (lifecycle) store.setJson("advice_task_lifecycle_latest", compactAdviceTaskLifecycle(lifecycle));
  const retention = store.enforceRetentionBudget();
  const checkpointBeforeVacuum = store.checkpoint("TRUNCATE");
  const vacuum = shouldVacuum ? store.vacuum() : null;
  const checkpoint = store.checkpoint("TRUNCATE");
  const after = {
    files: {
      sqlite: fileBytes(store.paths.sqliteFile),
      wal: fileBytes(`${store.paths.sqliteFile}-wal`),
      shm: fileBytes(`${store.paths.sqliteFile}-shm`),
    },
    tables: tableSummary(store),
  };
  const retiredVersionResetReceipt = retiredVersionReset
    ? writeResetReceipt(store.paths, retiredSeason)
    : null;
  process.stdout.write(`${JSON.stringify({
    ok: true,
    schema: "jcc-runtime-db-maintenance-v1",
    vacuum_requested: shouldVacuum,
    retired_version_reset_requested: resetRetiredVersionRuntime,
    retired_version_reset: retiredVersionReset,
    retired_version_reset_receipt: retiredVersionResetReceipt,
    retention,
    checkpoint_before_vacuum: checkpointBeforeVacuum,
    vacuum,
    checkpoint,
    before,
    after,
  }, null, 2)}\n`);
} finally {
  store.close();
}
