import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createRuntimePaths,
  createRuntimeSqliteStore,
  readJson,
  writeJsonAtomic,
} from "../ui/electron/runtime-state-store.js";

function usage() {
  return [
    "Usage:",
    "  node tools/migrate-jcc-runtime-data-dir.mjs [--data-dir <dir>] [--dry-run]",
    "",
    "Migrates durable legacy .omx state mirrors into the canonical JCC runtime data dir.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--data-dir") options.dataDir = argv[++index];
    else if (arg === "--dry-run") options.dryRun = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function copyJsonIfExists(source, target, migrated) {
  const value = await readJson(source, null);
  if (!value) return null;
  await writeJsonAtomic(target, value);
  migrated.push({ source, target });
  return value;
}

export async function migrateRuntimeDataDir(options = {}) {
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const paths = createRuntimePaths(repoRoot, { dataRoot: options.dataDir });
  const legacyStateDir = paths.legacyStateDir;
  const markerFile = path.join(paths.runtimeDataRoot, "migration", "legacy-omx-state.json");
  const migrated = [];
  const plan = {
    schema: "jcc-runtime-data-dir-migration-v1",
    repo_root: repoRoot,
    runtime_data_root: paths.runtimeDataRoot,
    sqlite_file: paths.sqliteFile,
    legacy_state_dir: legacyStateDir,
    dry_run: Boolean(options.dryRun),
    migration_marker: markerFile,
    migrated,
  };
  if (options.dryRun) return plan;

  await mkdir(path.dirname(markerFile), { recursive: true });
  const userSettings = await copyJsonIfExists(
    path.join(legacyStateDir, "jcc-runtime-user-settings.json"),
    paths.userSettingsFile,
    migrated,
  );
  const userMemory = await copyJsonIfExists(
    path.join(legacyStateDir, "jcc-runtime-user-memory.json"),
    paths.userMemoryFile,
    migrated,
  );
  const matchSession = await copyJsonIfExists(
    path.join(legacyStateDir, "jcc-current-match-session.json"),
    paths.currentSessionFile,
    migrated,
  );
  const uiState = await copyJsonIfExists(paths.legacyUiStateFile, paths.uiStateFile, migrated);

  const store = createRuntimeSqliteStore(repoRoot, { dataRoot: paths.runtimeDataRoot }).open();
  try {
    if (userSettings) store.setJson("user_preferences", userSettings);
    if (userMemory) store.setJson("user_memory", userMemory);
    if (matchSession?.match_session_id) {
      store.upsertSession(matchSession.match_session_id, "match_session", "migrated", matchSession);
    }
    if (uiState) store.setJson("ui_state", uiState);
    store.setJson("runtime_data_migration", {
      ...plan,
      migrated_count: migrated.length,
      completed_at: new Date().toISOString(),
    });
  } finally {
    store.close();
  }
  await writeFile(markerFile, `${JSON.stringify({
    ...plan,
    migrated_count: migrated.length,
    completed_at: new Date().toISOString(),
  }, null, 2)}\n`, "utf8");
  return {
    ...plan,
    migrated_count: migrated.length,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const result = await migrateRuntimeDataDir(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}
