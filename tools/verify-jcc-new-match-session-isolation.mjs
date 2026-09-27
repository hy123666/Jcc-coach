import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createActiveCoreProfileSnapshot } from "./jcc_test_core_profile_fixture.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runNode(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: path.resolve(import.meta.dirname, ".."),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => resolve({ code: 1, stdout, stderr: error.message || String(error) }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function main() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "jcc-new-match-session-"));
  try {
    const capturedSnapshot = createActiveCoreProfileSnapshot(repoRoot);
    const capturedSnapshotArg = Buffer.from(JSON.stringify(capturedSnapshot), "utf8").toString("base64url");
    for (const file of [
      "state.json",
      "summary.json",
      "events.jsonl",
      "cruise-live-state.json",
      "cruise-pipeline.json",
      "advice-lifecycle.json",
      "opponent-snapshots.json",
      "manual-match-variables.json",
      "match-context.json",
    ]) {
      await writeFile(path.join(tmp, file), JSON.stringify({
        old_match_session_id: "old-match",
        file,
        ...(file === "match-context.json" ? {
          user_confirmed_equipment: {
            match_session_id: "old-match",
            item_bench: [{ name: "old-match-item" }],
            equipped_items: [{ name: "old-match-equipped-item", owner_unit: "old-unit" }],
          },
          equipment_context_prompts: [{ asked_at: "2026-07-22T00:00:00.000Z" }],
        } : {}),
      }), "utf8");
    }
    await writeFile(path.join(tmp, "unknown-future-match-artifact.bin"), "old-match", "utf8");
    await mkdir(path.join(tmp, "dynamic-current-match-run"), { recursive: true });
    await writeFile(path.join(tmp, "dynamic-current-match-run", "snapshot.json"), "{}", "utf8");
    const preparedStateFile = path.join(tmp, "prepared-session-state.json");
    const prepared = await runNode([
      "tools/start-jcc-new-match-session.mjs",
      "--match-session-id", "prepared-match",
      "--out-dir", tmp,
      "--state-file", preparedStateFile,
      "--test-workspace-root", tmp,
      "--prepare-only",
      "--season-snapshot-base64url", capturedSnapshotArg,
    ]);
    assert(prepared.code === 0, `prepare new match failed\n${prepared.stdout}\n${prepared.stderr}`);
    assert(JSON.parse(prepared.stdout).prepare_only === true, "prepare-only must return an uncommitted boundary candidate");
    assert(await readFile(path.join(tmp, "unknown-future-match-artifact.bin"), "utf8") === "old-match", "prepare-only must not clear the old watcher workspace");
    let preparedStateExists = true;
    try { await readFile(preparedStateFile, "utf8"); } catch { preparedStateExists = false; }
    assert(preparedStateExists === false, "prepare-only must not publish a current-session marker before the old watcher stops");
    const stateFile = path.join(tmp, "session-state.json");
    const result = await runNode([
      "tools/start-jcc-new-match-session.mjs",
      "--match-session-id", "new-match",
      "--out-dir", tmp,
      "--state-file", stateFile,
      "--test-workspace-root", tmp,
      "--season-snapshot-base64url", capturedSnapshotArg,
    ]);
    assert(result.code === 0, `start new match failed\n${result.stdout}\n${result.stderr}`);
    const state = JSON.parse(result.stdout);
    assert(state.schema === "jcc-current-match-session-state-v1", "session state schema mismatch");
    assert(state.match_session_id === "new-match", "new match id mismatch");
    assert(state.reset_policy?.old_match_pollution_allowed === false, "old match pollution guard missing");
    assert(state.season_version_snapshot?.schema === "jcc-match-season-version-snapshot-v1", "season version snapshot missing");
    assert(state.season_version_snapshot?.activation_policy === "new_match_only", "season version activation must be new-match-only");
    const promotionTuple = state.season_version_snapshot?.promotion_tuple;
    assert(Boolean(promotionTuple?.season_id), "season snapshot must include runtime season id");
    assert(Boolean(promotionTuple?.active_patch_id), "season snapshot must include active patch id");
    assert(Boolean(promotionTuple?.game_mode_id), "season snapshot must include game mode id");
    assert(Boolean(promotionTuple?.package_id), "season snapshot must include package id");
    assert(Boolean(promotionTuple?.hard_data_manifest), "season snapshot must include hard-data manifest");
    assert(/^[a-f0-9]{64}$/.test(state.season_version_snapshot?.rules_source_fingerprint || ""), "season snapshot must pin the exact active rules fingerprint");

    const promotedSnapshot = {
      ...state.season_version_snapshot,
      core_profile_id: "b".repeat(64),
      rules_source_fingerprint: "c".repeat(64),
      promotion_tuple: {
        ...promotionTuple,
        core_profile_id: "b".repeat(64),
      },
      core_profile_ref: {
        ...state.season_version_snapshot.core_profile_ref,
        core_profile_id: "b".repeat(64),
      },
      core_source_identity: {
        ...state.season_version_snapshot.core_source_identity,
        core_profile_id: "b".repeat(64),
      },
      ranking_overlay_identity: {
        ...state.season_version_snapshot.ranking_overlay_identity,
        core_profile_id: "b".repeat(64),
      },
      recipe_catalog_identity: {
        ...state.season_version_snapshot.recipe_catalog_identity,
        core_profile_id: "b".repeat(64),
      },
      captured_at: "2026-08-19T00:00:00.000Z",
    };
    const explicitSnapshotRun = await runNode([
      "tools/start-jcc-new-match-session.mjs",
      "--match-session-id", "promoted-snapshot-match",
      "--out-dir", tmp,
      "--state-file", path.join(tmp, "promoted-snapshot-state.json"),
      "--test-workspace-root", tmp,
      "--prepare-only",
      "--season-snapshot-base64url", Buffer.from(JSON.stringify(promotedSnapshot), "utf8").toString("base64url"),
    ]);
    assert(explicitSnapshotRun.code === 0, `explicit promoted snapshot failed\n${explicitSnapshotRun.stderr}`);
    assert(
      JSON.stringify(JSON.parse(explicitSnapshotRun.stdout).season_version_snapshot) === JSON.stringify(promotedSnapshot),
      "the Start Match child must use the one snapshot captured by Runtime instead of re-reading the active pointer",
    );
    const runtimeServiceSource = await readFile(path.resolve(import.meta.dirname, "..", "ui", "electron", "runtime-service.js"), "utf8");
    const startMatchBody = runtimeServiceSource.slice(
      runtimeServiceSource.indexOf("async function startMatch()"),
      runtimeServiceSource.indexOf("async function stopMatch()"),
    );
    assert(
      startMatchBody.indexOf("configureRuntimeServicePaths") < startMatchBody.indexOf("captureMatchSeasonVersionSnapshot"),
      "Start Match must refresh the active profile before capturing its one immutable snapshot",
    );
    assert(startMatchBody.includes('"--season-snapshot-base64url"'), "Start Match must pass that exact snapshot to its child process");
    const persisted = JSON.parse(await readFile(stateFile, "utf8"));
    assert(persisted.match_session_id === "new-match", "persisted state mismatch");
    assert(
      JSON.stringify(persisted.season_version_snapshot) === JSON.stringify(state.season_version_snapshot),
      "persisted state must retain the exact new-match season snapshot",
    );
    const matchSession = JSON.parse(await readFile(path.join(tmp, "match-session.json"), "utf8"));
    assert(matchSession.match_session_id === "new-match", "out-dir match session marker missing");

    const protectedMarker = path.join(tmp, "protected-marker.txt");
    await writeFile(protectedMarker, "must-survive", "utf8");
    const unauthorizedTemp = await runNode([
      "tools/start-jcc-new-match-session.mjs",
      "--match-session-id", "unauthorized-temp",
      "--out-dir", tmp,
      "--state-file", path.join(tmp, "unauthorized-state.json"),
      "--season-snapshot-base64url", capturedSnapshotArg,
      "--dry-run",
    ]);
    assert(unauthorizedTemp.code !== 0, "custom workspace must require explicit test authorization");
    assert(/require --test-workspace-root/i.test(unauthorizedTemp.stderr), "missing test authorization must explain the required guard");
    assert(await readFile(protectedMarker, "utf8") === "must-survive", "rejected custom workspace must remain byte-identical");

    const broadTempRoot = await runNode([
      "tools/start-jcc-new-match-session.mjs",
      "--match-session-id", "broad-temp-root",
      "--out-dir", tmp,
      "--state-file", path.join(tmp, "broad-temp-state.json"),
      "--test-workspace-root", os.tmpdir(),
      "--season-snapshot-base64url", capturedSnapshotArg,
      "--dry-run",
    ]);
    assert(broadTempRoot.code !== 0, "the OS temporary root must not authorize arbitrary children");
    assert(/dedicated child/i.test(broadTempRoot.stderr), "broad temporary-root rejection must explain the dedicated-root requirement");

    const unsafeTarget = path.resolve(import.meta.dirname, "..");
    const unsafe = await runNode([
      "tools/start-jcc-new-match-session.mjs",
      "--match-session-id", "unsafe-match",
      "--out-dir", unsafeTarget,
      "--state-file", path.join(tmp, "unsafe-state.json"),
      "--test-workspace-root", tmp,
      "--season-snapshot-base64url", capturedSnapshotArg,
      "--dry-run",
    ]);
    assert(unsafe.code !== 0, "Start Match must reject a workspace outside its declared test root");
    assert(/must stay inside the declared test root/i.test(unsafe.stderr), "unsafe workspace rejection must explain the boundary violation");
    for (const file of [
      "state.json",
      "summary.json",
      "events.jsonl",
      "cruise-live-state.json",
      "cruise-pipeline.json",
      "advice-lifecycle.json",
      "opponent-snapshots.json",
      "manual-match-variables.json",
      "match-context.json",
    ]) {
      let exists = true;
      try {
        await readFile(path.join(tmp, file), "utf8");
      } catch {
        exists = false;
      }
      assert(exists === false, `${file} should be cleared for new match`);
    }
    for (const entry of ["unknown-future-match-artifact.bin", "dynamic-current-match-run"]) {
      let exists = true;
      try {
        await readFile(path.join(tmp, entry), "utf8");
      } catch {
        exists = false;
      }
      assert(exists === false, `${entry} should be cleared without a fixed filename allowlist`);
    }
    console.log(JSON.stringify({
      ok: true,
      checked: [
        "Start New Match creates a fresh match_session_id marker",
        "prepare-only creates identity without clearing or publishing over a live old watcher",
        "current live_state/advice/opponent/manual/context artifacts are cleared",
        "old match artifacts are not allowed to pollute the new session",
        "old user-confirmed equipment and equipment prompts are cleared with match context",
        "season, patch, mode, package, and hard-data identity are frozen for the new match",
        "exact compiled rules fingerprint is frozen for the new match",
        "a newly promoted profile is captured once and passed unchanged to the Start Match child",
        "future and dynamic current-match artifacts are cleared without a fixed filename allowlist",
        "custom, broad temporary, and repository workspaces fail closed without deleting content",
      ],
    }, null, 2));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
