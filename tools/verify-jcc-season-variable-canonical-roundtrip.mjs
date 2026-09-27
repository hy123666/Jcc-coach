import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { JccRuntimeDaemon } from "../ui/electron/runtime-daemon.js";
import { getRuntimeServiceState, setRuntimeServiceState } from "../ui/electron/runtime-service.js";
import { isTransientWindowsFileLock } from "../ui/electron/runtime-state-store.js";
import { createActiveCoreProfileSnapshot } from "./jcc_test_core_profile_fixture.mjs";
import { startSession } from "./start-jcc-new-match-session.mjs";

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-season-variable-roundtrip-"));
const previousDisableHost = process.env.JCC_UI_DISABLE_CODEX_EXEC;
let daemon = null;

function valueForField(field, options) {
  const names = (options?.[field.option_group] || []).map((entry) => entry?.name).filter(Boolean);
  if (field.control === "multi_select") return names.slice(0, Math.min(2, field.max_items || 2));
  return names[0] || `verify-${field.key}`;
}

function encodedSnapshot(snapshot) {
  return Buffer.from(JSON.stringify(snapshot), "utf8").toString("base64url");
}

async function removeTempRootWithWindowsLockRetry(directory) {
  let lastError = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return;
    } catch (error) {
      lastError = error;
      if (!isTransientWindowsFileLock(error) || attempt === 7) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000, 100 * 2 ** attempt)));
    }
  }
  throw lastError;
}

try {
  process.env.JCC_UI_DISABLE_CODEX_EXEC = "1";
  const explicitSnapshot = createActiveCoreProfileSnapshot(process.cwd(), {
    capturedAt: "2026-08-21T00:00:00.000Z",
  });
  const watchDir = path.join(tempRoot, "watch");
  const stateFile = path.join(tempRoot, "current-match-session.json");
  await mkdir(watchDir, { recursive: true });
  const boundarySentinel = path.join(watchDir, "must-survive-rejected-boundary.txt");
  await writeFile(boundarySentinel, "preserve until snapshot validation succeeds", "utf8");

  await assert.rejects(
    startSession({
      matchSessionId: "verify-missing-season-snapshot",
      outDir: watchDir,
      stateFile,
      testWorkspaceRoot: tempRoot,
    }),
    /requires --season-snapshot-base64url/i,
  );
  assert.equal(
    await readFile(boundarySentinel, "utf8"),
    "preserve until snapshot validation succeeds",
    "a rejected Start Match boundary must not clear the current workspace",
  );

  await assert.rejects(
    startSession({
      matchSessionId: "verify-incomplete-season-snapshot",
      outDir: watchDir,
      stateFile,
      testWorkspaceRoot: tempRoot,
      seasonSnapshotBase64Url: encodedSnapshot({
        schema: "jcc-match-season-version-snapshot-v1",
        core_profile_id: explicitSnapshot.core_profile_id,
      }),
    }),
    /explicit season snapshot is incomplete/i,
  );
  assert.equal(
    await readFile(boundarySentinel, "utf8"),
    "preserve until snapshot validation succeeds",
    "an incomplete snapshot must fail before workspace cleanup",
  );

  await assert.rejects(
    startSession({
      matchSessionId: "verify-inconsistent-season-snapshot",
      outDir: watchDir,
      stateFile,
      testWorkspaceRoot: tempRoot,
      seasonSnapshotBase64Url: encodedSnapshot({
        ...explicitSnapshot,
        core_source_identity: {
          ...explicitSnapshot.core_source_identity,
          core_profile_id: "f".repeat(64),
        },
      }),
    }),
    /explicit season snapshot is incomplete/i,
  );
  assert.equal(
    await readFile(boundarySentinel, "utf8"),
    "preserve until snapshot validation succeeds",
    "an internally inconsistent snapshot must fail before workspace cleanup",
  );

  const retiredWatcherBoundary = spawnSync(process.execPath, [
    path.join(process.cwd(), "tools", "start-jcc-mumu-runtime-watch.mjs"),
    "--start-new-match",
    "--dry-run",
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
  });
  assert.notEqual(retiredWatcherBoundary.status, 0, "watcher must not create a Start Match boundary");
  assert.match(
    retiredWatcherBoundary.stderr,
    /--start-new-match is retired/i,
    "watcher must explain that canonical Start Match owns the boundary",
  );

  daemon = new JccRuntimeDaemon({ repoRoot: process.cwd(), dataRoot: tempRoot }).start();
  const baseline = getRuntimeServiceState();
  const matchSession = await startSession({
    matchSessionId: "verify-season-variable-roundtrip",
    outDir: watchDir,
    stateFile,
    testWorkspaceRoot: tempRoot,
    seasonSnapshotBase64Url: encodedSnapshot(explicitSnapshot),
    dryRun: true,
  });
  assert.deepEqual(
    matchSession.season_version_snapshot,
    explicitSnapshot,
    "Start Match child must preserve the caller-captured snapshot without re-resolving active state",
  );
  daemon.store.setJson("ui_runtime_state", {
    ...baseline,
    match_session: {
      ...(baseline.match_session || {}),
      status: "active",
      match_session_id: matchSession.match_session_id,
      season_version_snapshot: matchSession.season_version_snapshot,
    },
    match_connection: {
      status: "connected_to_live_match",
      last_live_state_match_session_id: "verify-season-variable-roundtrip",
    },
    active_mode: "cruise",
    response_task: { status: "idle", response_task_id: null, revision: 0 },
    response_task_revision: 0,
  });

  const optionResult = await daemon.handleAction("getManualVariableOptions", {}, null);
  const fields = optionResult.season_variable_fields || [];
  assert.equal(fields.length, 0, "active S18 descriptor must expose no manual variables");
  const seasonVariables = Object.fromEntries(fields.map((field) => [
    field.key,
    valueForField(field, optionResult.options),
  ]));

  const saved = await daemon.handleAction("saveManualVariables", {
    seasonVariables,
    target: "verify descriptor-driven target",
  }, null);
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.variables?.values?.season_variables, seasonVariables);
  assert.deepEqual(saved.state?.match_context?.match_variables, seasonVariables);
  const canonicalAfterSave = daemon.store.getJson("ui_runtime_state");
  assert.deepEqual(canonicalAfterSave.manual_match_variables?.values?.season_variables, seasonVariables);
  assert.deepEqual(canonicalAfterSave.match_context?.match_variables, seasonVariables);
  assert.equal(Object.hasOwn(canonicalAfterSave.manual_match_variables?.values || {}, "firstGod"), false);

  daemon.stop();
  daemon = null;
  setRuntimeServiceState({
    schema: "jcc-ui-runtime-state-v1",
    match_session: { status: "idle", match_session_id: null },
    response_task: { status: "idle", response_task_id: null },
    manual_match_variables: null,
    match_context: null,
  });

  daemon = new JccRuntimeDaemon({ repoRoot: process.cwd(), dataRoot: tempRoot }).start();
  const hydrated = await daemon.hydrateServiceState({ allowBootstrap: false });
  assert.deepEqual(hydrated.manual_match_variables?.values?.season_variables, seasonVariables);
  assert.deepEqual(hydrated.match_context?.match_variables, seasonVariables);

  const messageResult = await daemon.handleAction("sendMessage", {
    mode: "cruise",
    text: "Use the confirmed match variables and give the next strategic direction.",
  }, null);
  assert.equal(messageResult.status, "awaiting_host_cli_agent_response");
  const hostRequest = messageResult.host_request || messageResult.state?.response_task?.host_request;
  assert(hostRequest, "disabled-host direct message must expose the real Host request");
  assert.deepEqual(hostRequest.runtime_context?.match_facts?.match_variables, seasonVariables);

  console.log(JSON.stringify({
    ok: true,
    schema: "jcc-season-variable-canonical-roundtrip-verifier-v1",
    checked: [
      "Start Match rejects missing or incomplete explicit Core Profile snapshots before cleanup",
      "Start Match preserves the caller-captured snapshot byte-for-byte at the value level",
      "MuMu watcher cannot create an implicit match boundary",
      "descriptor-declared empty S18 season variables save through daemon",
      "SQLite remains canonical across in-memory reset and hydrate",
      "Host selected context receives the hydrated season variables",
      "generic payload does not persist legacy UI field names",
    ],
    field_keys: fields.map((field) => field.key),
  }, null, 2));
} finally {
  if (daemon) {
    await daemon.handleAction("shutdown", { reason: "verify_season_variable_roundtrip_cleanup" }, null).catch(() => {});
    daemon.stop();
  }
  if (previousDisableHost === undefined) delete process.env.JCC_UI_DISABLE_CODEX_EXEC;
  else process.env.JCC_UI_DISABLE_CODEX_EXEC = previousDisableHost;
  await new Promise((resolve) => setTimeout(resolve, 100));
  await removeTempRootWithWindowsLockRetry(tempRoot);
}
